import { describe, expect, test } from 'bun:test';
import type { GatewayListener, GatewayNotification } from '../agentGateway';
import { DaemonAgentRunner } from '../daemonRunner';
import type { HostToDaemonMessage } from '../daemon/protocol';
import type { AgentEvent } from '../events';

/** Steuerbares Fake-Gateway: Test spielt Daemon-Nachrichten ein. */
class FakeGateway {
  readonly sent: HostToDaemonMessage[] = [];
  connected = true;
  sendSucceeds = true;
  invalidated: string[] = [];
  private readonly listeners = new Map<string, Set<GatewayListener>>();

  invalidate(sandbox: string): void {
    this.invalidated.push(sandbox);
  }

  async waitForConnection(sandbox: string, timeoutMs: number): Promise<void> {
    if (this.connected) return;
    throw new Error(`Agent-Daemon von ${sandbox} hat sich nicht verbunden (${timeoutMs}ms)`);
  }

  send(_sandbox: string, message: HostToDaemonMessage): boolean {
    if (!this.sendSucceeds) return false;
    this.sent.push(message);
    return true;
  }

  subscribe(sandbox: string, listener: GatewayListener): () => void {
    const set = this.listeners.get(sandbox) ?? new Set();
    this.listeners.set(sandbox, set);
    set.add(listener);
    return () => set.delete(listener);
  }

  notify(sandbox: string, notification: GatewayNotification): void {
    for (const listener of [...(this.listeners.get(sandbox) ?? [])]) {
      listener(notification);
    }
  }

  emitEvent(sandbox: string, turnId: string, event: AgentEvent): void {
    this.notify(sandbox, { kind: 'message', message: { kind: 'event', turnId, event } });
  }

  listenerCount(sandbox: string): number {
    return this.listeners.get(sandbox)?.size ?? 0;
  }
}

function makeRunner(gateway: FakeGateway, connectTimeoutMs = 100, ackTimeoutMs = 5_000) {
  return new DaemonAgentRunner({
    gateway,
    sandboxNameFor: (projectId) => `sb-${projectId}`,
    model: 'claude-sonnet-5',
    connectTimeoutMs,
    ackTimeoutMs,
  });
}

const TURN = {
  projectId: 'p1',
  prompt: 'Baue eine Todo-App',
  workspaceDir: '/host/pfad/egal',
  resumeSessionId: 'sess-1',
};

/** turnId des zuerst gesendeten start-turn-Kommandos. */
function firstTurnId(gw: FakeGateway): string {
  const first = gw.sent[0];
  return first !== undefined && first.kind === 'start-turn' ? first.turnId : '';
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

async function tick(): Promise<void> {
  await Bun.sleep(5);
}

describe('DaemonAgentRunner', () => {
  test('startTurn schickt start-turn mit Prompt/Resume/Modell und streamt Events bis turn-completed', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw);

    const handle = runner.startTurn(TURN);
    const collected = collect(handle.events);
    await tick();

    expect(gw.sent).toHaveLength(1);
    const start = gw.sent[0]!;
    expect(start).toMatchObject({
      kind: 'start-turn',
      prompt: 'Baue eine Todo-App',
      resumeSessionId: 'sess-1',
      model: 'claude-sonnet-5',
    });
    const turnId = start.kind === 'start-turn' ? start.turnId : '';

    gw.emitEvent('sb-p1', turnId, { type: 'session', sessionId: 'sess-1' });
    gw.emitEvent('sb-p1', 'fremder-turn', { type: 'text-delta', text: 'IGNORIEREN' });
    gw.emitEvent('sb-p1', turnId, { type: 'text-delta', text: 'Hallo' });
    gw.emitEvent('sb-p1', turnId, { type: 'turn-completed', sessionId: 'sess-1' });

    expect(await collected).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'text-delta', text: 'Hallo' },
      { type: 'turn-completed', sessionId: 'sess-1' },
    ]);
    // Nach Turn-Ende ist der Listener abbestellt.
    expect(gw.listenerCount('sb-p1')).toBe(0);
  });

  test('Daemon nicht verbunden → error + turn-aborted statt Hänger', async () => {
    const gw = new FakeGateway();
    gw.connected = false;
    const runner = makeRunner(gw, 30);

    const events = await collect(runner.startTurn(TURN).events);
    expect(events[0]?.type).toBe('error');
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
    expect(gw.sent).toHaveLength(0);
  });

  test('send schlägt fehl (Race beim Disconnect) → error + turn-aborted', async () => {
    const gw = new FakeGateway();
    gw.sendSucceeds = false;
    const runner = makeRunner(gw);

    const events = await collect(runner.startTurn(TURN).events);
    expect(events[0]?.type).toBe('error');
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
  });

  test('Disconnect mitten im Turn → error + turn-aborted', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw);

    const handle = runner.startTurn(TURN);
    const collected = collect(handle.events);
    await tick();

    const turnId = firstTurnId(gw);
    gw.emitEvent('sb-p1', turnId, { type: 'text-delta', text: 'Anfang' });
    gw.notify('sb-p1', { kind: 'disconnected' });

    const events = await collected;
    expect(events[0]).toEqual({ type: 'text-delta', text: 'Anfang' });
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
  });

  test('abort() schickt interrupt und beendet den Stream mit turn-aborted', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw);

    const handle = runner.startTurn(TURN);
    const collected = collect(handle.events);
    await tick();
    const turnId = firstTurnId(gw);

    handle.abort();
    await tick();

    expect(gw.sent.at(-1)).toEqual({ kind: 'interrupt', turnId });
    const events = await collected;
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
    expect(gw.listenerCount('sb-p1')).toBe(0);
  });

  test('ready-Nachrichten des Daemons stören einen laufenden Turn nicht', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw);

    const handle = runner.startTurn(TURN);
    const collected = collect(handle.events);
    await tick();
    const turnId = firstTurnId(gw);

    gw.notify('sb-p1', { kind: 'message', message: { kind: 'ready' } });
    gw.emitEvent('sb-p1', turnId, { type: 'turn-completed', sessionId: null });

    expect(await collected).toEqual([{ type: 'turn-completed', sessionId: null }]);
  });

  test('ohne turn-started-Quittung: schneller Abbruch + Verbindung verworfen (halbtote NAT-Verbindung)', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw, 100, 40);

    const events = await collect(runner.startTurn(TURN).events);

    expect(gw.invalidated).toEqual(['sb-p1']);
    expect(events[0]?.type).toBe('error');
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
  });

  test('turn-started-Quittung entschärft den Wächter — Turn läuft normal weiter', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw, 100, 40);

    const handle = runner.startTurn(TURN);
    const collected = collect(handle.events);
    await tick();
    const turnId = firstTurnId(gw);

    gw.notify('sb-p1', { kind: 'message', message: { kind: 'turn-started', turnId } });
    await Bun.sleep(80); // länger als ackTimeoutMs — der Wächter darf nicht feuern
    gw.emitEvent('sb-p1', turnId, { type: 'turn-completed', sessionId: 's-1' });

    const events = await collected;
    expect(gw.invalidated).toEqual([]);
    expect(events).toEqual([{ type: 'turn-completed', sessionId: 's-1' }]);
  });

  test('resumeSessionId null wird durchgereicht (frischer Start)', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw);

    const handle = runner.startTurn({ ...TURN, resumeSessionId: null });
    const collected = collect(handle.events);
    await tick();

    expect(gw.sent[0]).toMatchObject({ kind: 'start-turn', resumeSessionId: null });
    const turnId = firstTurnId(gw);
    gw.emitEvent('sb-p1', turnId, { type: 'turn-completed', sessionId: 's-neu' });
    await collected;
  });
});
