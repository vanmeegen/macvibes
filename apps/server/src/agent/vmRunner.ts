import { parseStreamJsonLine } from './claudeStreamJson';
import type { AgentEvent } from './events';
import type { AgentRunner, TurnHandle, TurnOptions } from './runner';

/** Ein gestarteter Prozess, reduziert auf das, was der Runner braucht (Test-Naht). */
export interface ExecProcess {
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
  readonly exited: Promise<number>;
}

/**
 * Startet Claude Code in der laufenden Sandbox eines Projekts. Bekommt
 * `sandboxName` + `env` (u. a. ANTHROPIC_BASE_URL auf den Host-Proxy und das
 * Proxy-Secret) und liefert einen streamenden Prozess. In Produktion: msb exec.
 */
export type ExecSpawner = (params: {
  sandboxName: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}) => ExecProcess;

export interface VmAgentRunnerConfig {
  /** Sandbox-Name zu einem Projekt (muss mit dem Provider übereinstimmen). */
  sandboxNameFor: (projectId: string) => string;
  /** Env für den Agenten in der VM (Credential-Proxy, R10). */
  agentEnv: () => Record<string, string>;
  spawn: ExecSpawner;
  /** Arbeitsverzeichnis in der VM (gemounteter Workspace). */
  guestWorkdir: string;
}

/**
 * VM-Agent-Runner (B5c): treibt Claude Code per `msb exec` in der Sandbox,
 * parst dessen stream-json-Ausgabe zu AgentEvents. Der Runner hält keine
 * Credentials — die kommen über den Host-Proxy (ANTHROPIC_BASE_URL).
 */
export class VmAgentRunner implements AgentRunner {
  constructor(private readonly config: VmAgentRunnerConfig) {}

  startTurn(options: TurnOptions): TurnHandle {
    const args = [
      'claude',
      '-p',
      options.prompt,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ];
    if (options.resumeSessionId !== null) {
      args.push('--resume', options.resumeSessionId);
    }

    const proc = this.config.spawn({
      sandboxName: this.config.sandboxNameFor(options.projectId),
      args,
      env: this.config.agentEnv(),
      cwd: this.config.guestWorkdir,
    });

    const events = (async function* (): AsyncGenerator<AgentEvent> {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawResult = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            for (const event of parseStreamJsonLine(line)) {
              if (event.type === 'turn-completed' || event.type === 'turn-aborted') {
                sawResult = true;
              }
              yield event;
            }
            newline = buffer.indexOf('\n');
          }
        }
        for (const event of parseStreamJsonLine(buffer)) {
          if (event.type === 'turn-completed' || event.type === 'turn-aborted') sawResult = true;
          yield event;
        }
      } finally {
        reader.releaseLock();
      }

      const exitCode = await proc.exited;
      // Bricht der Prozess ohne result-Zeile ab (Crash, Kill), sauber melden.
      if (!sawResult) {
        if (exitCode === 0) {
          yield { type: 'turn-completed', sessionId: null };
        } else {
          yield { type: 'turn-aborted' };
        }
      }
    })();

    return {
      events,
      abort: () => proc.kill(),
    };
  }
}
