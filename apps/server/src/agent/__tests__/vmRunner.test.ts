import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '../events';
import { VmAgentRunner, type ExecProcess, type ExecSpawner } from '../vmRunner';

function streamOf(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      // In Chunks, die Zeilengrenzen absichtlich zerreißen (Buffering testen).
      const blob = lines.join('\n') + '\n';
      const mid = Math.floor(blob.length / 2);
      controller.enqueue(encoder.encode(blob.slice(0, mid)));
      controller.enqueue(encoder.encode(blob.slice(mid)));
      controller.close();
    },
  });
}

function fakeSpawner(
  lines: string[],
  exitCode = 0,
): {
  spawn: ExecSpawner;
  captured: { args: string[]; env: Record<string, string>; sandboxName: string } | null;
  killed: boolean;
} {
  const box = { captured: null as never, killed: false };
  const spawn: ExecSpawner = (params) => {
    box.captured = { args: params.args, env: params.env, sandboxName: params.sandboxName } as never;
    const proc: ExecProcess = {
      stdout: streamOf(lines),
      kill: () => {
        box.killed = true;
      },
      exited: Promise.resolve(exitCode),
    };
    return proc;
  };
  return {
    spawn,
    get captured() {
      return box.captured;
    },
    get killed() {
      return box.killed;
    },
  };
}

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

function makeRunner(spawn: ExecSpawner): VmAgentRunner {
  return new VmAgentRunner({
    sandboxNameFor: (id: string) => `macvibes-${id}`,
    agentEnv: () => ({ ANTHROPIC_BASE_URL: 'http://host.microsandbox.internal:4000/anthropic' }),
    spawn,
    guestWorkdir: '/work',
  });
}

describe('VmAgentRunner (B5c)', () => {
  test('parst stream-json über zerrissene Chunks und liefert Events in Reihenfolge', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hallo ' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Welt' } },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-1' }),
    ];
    const runner = makeRunner(fakeSpawner(lines).spawn);
    const events = await collect(
      runner.startTurn({
        projectId: 'projekt-1',
        prompt: 'Hi',
        workspaceDir: '/w',
        resumeSessionId: null,
      }).events,
    );

    expect(events).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'text-delta', text: 'Hallo ' },
      { type: 'text-delta', text: 'Welt' },
      { type: 'turn-completed', sessionId: 'sess-1' },
    ]);
  });

  test('übergibt Prompt, Resume und Agent-Env an msb exec', async () => {
    const fake = fakeSpawner([
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 's' }),
    ]);
    const runner = makeRunner(fake.spawn);
    await collect(
      runner.startTurn({
        projectId: 'projekt-1',
        prompt: 'Baue X',
        workspaceDir: '/w',
        resumeSessionId: 'sess-prev',
      }).events,
    );

    expect(fake.captured?.sandboxName).toBe('macvibes-projekt-1');
    expect(fake.captured?.args).toContain('Baue X');
    expect(fake.captured?.args).toContain('stream-json');
    expect(fake.captured?.args).toContain('bypassPermissions');
    const resumeIdx = fake.captured?.args.indexOf('--resume') ?? -1;
    expect(fake.captured?.args[resumeIdx + 1]).toBe('sess-prev');
    expect(fake.captured?.env['ANTHROPIC_BASE_URL']).toContain('host.microsandbox.internal');
  });

  test('ohne result-Zeile: Exit 0 → turn-completed, Exit ≠ 0 → turn-aborted', async () => {
    const ok = makeRunner(
      fakeSpawner([JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' })], 0).spawn,
    );
    const okEvents = await collect(
      ok.startTurn({
        projectId: 'projekt-1',
        prompt: 'x',
        workspaceDir: '/w',
        resumeSessionId: null,
      }).events,
    );
    expect(okEvents.at(-1)).toEqual({ type: 'turn-completed', sessionId: null });

    const crash = makeRunner(fakeSpawner([], 137).spawn);
    const crashEvents = await collect(
      crash.startTurn({
        projectId: 'projekt-1',
        prompt: 'x',
        workspaceDir: '/w',
        resumeSessionId: null,
      }).events,
    );
    expect(crashEvents.at(-1)).toEqual({ type: 'turn-aborted' });
  });

  test('abort killt den Prozess', async () => {
    const fake = fakeSpawner([
      JSON.stringify({ type: 'result', subtype: 'success', session_id: 's' }),
    ]);
    const runner = makeRunner(fake.spawn);
    const handle = runner.startTurn({
      projectId: 'projekt-1',
      prompt: 'x',
      workspaceDir: '/w',
      resumeSessionId: null,
    });
    handle.abort();
    await collect(handle.events);
    expect(fake.killed).toBe(true);
  });
});
