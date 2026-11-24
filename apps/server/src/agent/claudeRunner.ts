import { query } from '@anthropic-ai/claude-agent-sdk';
import { defaultAppendSystemPrompt } from './appendPrompt';
import type { AgentEvent } from './events';
import type { AgentRunner, TurnHandle, TurnOptions } from './runner';
import { agentEventsFromMessage } from './sdkMessageMapping';

export interface ClaudeAgentRunnerOptions {
  /**
   * Überschreibt die eingebaute Zusatz-System-Anweisung
   * (MACVIBES_AGENT_APPEND_PROMPT, seit M6 über config.agent.appendSystemPrompt
   * hereingereicht statt hier aus der Env gelesen); null = eingebauter Default
   * (agent/appendPrompt — derselbe wie im VM-Daemon).
   */
  appendSystemPrompt?: string | null;
}

/**
 * Treibt Claude Code über das Agent SDK im Projekt-Workspace.
 * Volle Autonomie (bypassPermissions) — die Isolation leistet die Sandbox.
 * Transiente API-Fehler behandelt das SDK selbst per Retry/Backoff (R6).
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(private readonly options: ClaudeAgentRunnerOptions = {}) {}

  startTurn(options: TurnOptions): TurnHandle {
    const abortController = new AbortController();

    const appendSystemPrompt =
      this.options.appendSystemPrompt ?? defaultAppendSystemPrompt(options.workspaceDir);

    const stream = query({
      prompt: options.prompt,
      options: {
        cwd: options.workspaceDir,
        model: options.model,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: appendSystemPrompt },
        // Projekt-Memory (AGENTS.md/CLAUDE.md) aus dem Workspace laden.
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        abortController,
        ...(options.resumeSessionId !== null ? { resume: options.resumeSessionId } : {}),
      },
    });

    const events = eventsFromSdkStream(stream, () => abortController.signal.aborted);

    return {
      events,
      abort: () => abortController.abort(),
    };
  }
}

/**
 * SDK-Stream → AgentEvents über dieselbe Abbildung wie der VM-Daemon
 * (agentEventsFromMessage), damit sich der Dev-Pfad nicht anders verhält als
 * die Produktion. Hier bleibt nur, was host-spezifisch ist: ein werfender
 * Stream endet als turn-aborted — mit Fehlermeldung, außer der Wurf ist die
 * Folge eines Abbruchs.
 */
export async function* eventsFromSdkStream(
  stream: AsyncIterable<unknown>,
  isAborted: () => boolean,
): AsyncGenerator<AgentEvent> {
  try {
    for await (const message of stream) {
      yield* agentEventsFromMessage(message);
    }
  } catch (error) {
    if (!isAborted()) {
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    yield { type: 'turn-aborted' };
  }
}
