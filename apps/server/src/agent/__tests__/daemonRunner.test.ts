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
  closedGracefully: string[] = [];
  /**
   * "Boot-Modus": solange gesetzt, gibt waitForConnection diese pendente
   * Promise zurück — der Daemon verbindet sich gerade erst (VM bootet).
   * Ohne das Gate löst waitForConnection sofort auf/ab, und die
   * M1-Konstellation (Abbruch WÄHREND des Verbindungsaufbaus) wäre untestbar.
   */
  connectGate: { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } | null =
    null;

  armConnectGate(): void {
    let resolve: () => void = () => {};
    let reject: (e: Error) => void = () => {};
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.connectGate = { promise, resolve, reject };
  }

  private readonly listeners = new Map<string, Set<GatewayListener>>();

  invalidate(sandbox: string): void {
    this.invalidated.push(sandbox);
  }

  closeGracefully(sandbox: string): void {
    this.closedGracefully.push(sandbox);
  }

  async waitForConnection(sandbox: string, timeoutMs: number): Promise<void> {
    if (this.connectGate !== null) return this.connectGate.promise;
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
    connectTimeoutMs,
    ackTimeoutMs,
  });
}

// Das Modell kommt PRO TURN aus den Optionen (Modellwahl pro Chat/Projekt),
// nicht mehr aus der Runner-Konfiguration.
const TURN = {
  projectId: 'p1',
  prompt: 'Baue eine Todo-App',
  workspaceDir: '/host/pfad/egal',
  resumeSessionId: 'sess-1',
  model: 'qwen3.6-coder',
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
      model: 'qwen3.6-coder',
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

  test('send schlägt fehl (Race beim Disconnect) → error + turn-aborted + Verbindung verworfen', async () => {
    const gw = new FakeGateway();
    gw.sendSucceeds = false;
    const runner = makeRunner(gw);

    const events = await collect(runner.startTurn(TURN).events);
    expect(events[0]?.type).toBe('error');
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
    // Seit send() auch bei verworfener Frame (ws.send() → 0) false liefert,
    // kann die Verbindung hier noch REGISTRIERT sein (gerade schließender
    // Socket). Bliebe sie stehen, kehrte waitForConnection des
    // chatService-Retrys sofort auf die sterbende Verbindung zurück und der
    // zweite send schlüge genauso fehl — der Retry könnte nie heilen. Deshalb
    // MUSS der Runner sie verwerfen (bei gar nicht registrierter Verbindung
    // ein No-Op), damit der Retry echt auf den frischen Daemon wartet.
    expect(gw.invalidated).toEqual(['sb-p1']);
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

/**
 * M1 aus dem Zustandsmaschinen-Audit: Stoppt der Nutzer, während der Daemon
 * gerade NICHT verbunden ist (VM-Boot, Daemon-Neustart nach turn-rejected),
 * hing der Generator in waitForConnection und abort() füllte nur eine Queue,
 * die nie gedraint wurde — der Event-Strom lieferte NIE turn-aborted und
 * verletzte damit seinen dokumentierten Vertrag (runner.ts: "Der Event-Strom
 * endet danach mit turn-aborted"). Der chatService lief in seinen Watchdog.
 */
describe('Abbruch während des Verbindungsaufbaus (M1)', () => {
  test('abort() beendet den Event-Strom sofort mit turn-aborted, obwohl waitForConnection noch hängt', async () => {
    const gw = new FakeGateway();
    gw.armConnectGate();
    const runner = makeRunner(gw, 60_000);

    const handle = runner.startTurn(TURN);
    const collected = collect(handle.events);
    await tick();

    handle.abort();

    const events = await Promise.race([collected, Bun.sleep(500).then(() => 'timeout' as const)]);
    expect(events).toEqual([{ type: 'turn-aborted' }]);
  });

  test('eine später doch noch scheiternde Verbindung erzeugt weder Nachzügler noch Unhandled Rejection', async () => {
    const abgefangen: unknown[] = [];
    const faenger = (reason: unknown): void => {
      abgefangen.push(reason);
    };
    process.on('unhandledRejection', faenger);
    try {
      const gw = new FakeGateway();
      gw.armConnectGate();
      const runner = makeRunner(gw, 60_000);

      const handle = runner.startTurn(TURN);
      const collected = collect(handle.events);
      await tick();
      handle.abort();
      const events = await Promise.race([collected, Bun.sleep(500).then(() => 'timeout' as const)]);
      expect(events).toEqual([{ type: 'turn-aborted' }]);

      // Die Verbindung scheitert erst NACH dem Stream-Ende (60-s-Timeout in
      // Produktion) — das darf keine Unhandled Rejection werden.
      gw.connectGate?.reject(new Error('Verbindung nie gekommen'));
      await tick();

      // Es wurde nie ein start-turn gesendet, nur der interrupt des abort().
      expect(gw.sent.every((m) => m.kind !== 'start-turn')).toBe(true);
      expect(abgefangen).toEqual([]);
    } finally {
      process.off('unhandledRejection', faenger);
    }
  });

  test('ein Abbruch VOR der ersten Iteration registriert gar keinen Verbindungs-Waiter', async () => {
    // runAttempt löst den Startfenster-Pin ein, BEVOR der Generator je
    // iteriert wurde. Der Generator-Body soll dann gar nicht erst
    // waitForConnection anwerfen — sonst hinge für bis zu 60 s ein Waiter
    // samt Timer im Gateway, der u. a. den Prozess-Shutdown offen hält.
    const gw = new FakeGateway();
    gw.armConnectGate();
    let verbindungAngefragt = false;
    const originalWait = gw.waitForConnection.bind(gw);
    gw.waitForConnection = async (sandbox: string, timeoutMs: number) => {
      verbindungAngefragt = true;
      return originalWait(sandbox, timeoutMs);
    };
    const runner = makeRunner(gw, 60_000);

    const handle = runner.startTurn(TURN);
    handle.abort(); // vor der ersten Iteration
    const events = await collect(handle.events);

    expect(events).toEqual([{ type: 'turn-aborted' }]);
    expect(verbindungAngefragt).toBe(false);
  });

  test('eine später doch noch gelingende Verbindung startet keinen Turn mehr', async () => {
    const gw = new FakeGateway();
    gw.armConnectGate();
    const runner = makeRunner(gw, 60_000);

    const handle = runner.startTurn(TURN);
    const collected = collect(handle.events);
    await tick();
    handle.abort();
    await collected;

    gw.connectGate?.resolve();
    await tick();
    expect(gw.sent.every((m) => m.kind !== 'start-turn')).toBe(true);
  });
});

/**
 * Selbstheilung fuer den einzigen Zustand, aus dem der Host den Daemon bisher
 * nicht herausholen konnte: Wedgt dessen SDK-Query, ohne dass die Verbindung
 * abreisst, bleibt currentTurnId gesetzt und die Notwehr-Sperre weist JEDEN
 * Folge-Turn ab. abandonTurn() greift dort nicht — es haengt am close-Handler.
 *
 * Das Protokoll hat fuer genau das eine shutdown-Nachricht: der Daemon beendet
 * sich, der In-VM-Supervisor startet ihn frisch. Nur gesendet hat sie nie
 * jemand — die dokumentierte Heilung existierte ausschliesslich auf dem Papier.
 */
describe('Verklemmter Daemon: Neustart anfordern', () => {
  test('sendet shutdown, wenn der Daemon den Turn ablehnt', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw);
    const handle = runner.startTurn(TURN);
    const gesammelt = collect(handle.events);
    await tick();

    gw.notify('sb-p1', {
      kind: 'message',
      message: { kind: 'turn-rejected', turnId: firstTurnId(gw) },
    });

    const events = await gesammelt;
    expect(gw.sent.some((m) => m.kind === 'shutdown')).toBe(true);
    // Die veraltete Verbindung des sich beendenden Daemons MUSS aus der
    // Registrierung — sonst kehrt waitForConnection des chatService-Retrys
    // sofort auf sie zurück und sendet in einen Socket, den niemand mehr
    // liest. Aber GEORDNET (close mit Handshake, flusht die shutdown-Frame),
    // NICHT abrupt (terminate/invalidate): terminate() verwirft die noch
    // gepufferte shutdown-Frame, der In-VM-Supervisor bekäme den Neustart nie
    // und der Daemon bliebe verklemmt.
    expect(gw.closedGracefully).toContain('sb-p1');
    expect(gw.invalidated).toEqual([]);
    // Der Turn endet — der Retry des chatService trifft den frischen Daemon.
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
  });

  test('meldet einen Fehler, wenn nicht einmal der Neustart zugestellt werden kann', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw);
    const handle = runner.startTurn(TURN);
    const gesammelt = collect(handle.events);
    await tick();
    const turnId = firstTurnId(gw);

    // Ab jetzt geht nichts mehr raus (Verbindung weg).
    gw.sendSucceeds = false;
    gw.notify('sb-p1', { kind: 'message', message: { kind: 'turn-rejected', turnId } });

    const events = await gesammelt;
    // Sonst stuende der Nutzer ohne jede Erklaerung da.
    const fehler = events.find((e) => e.type === 'error');
    expect(fehler).toBeDefined();
    expect(fehler?.type === 'error' && fehler.message).toContain('blockiert');
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
  });

  test('eine Ablehnung fuer einen FREMDEN Turn wird ignoriert', async () => {
    const gw = new FakeGateway();
    const runner = makeRunner(gw);
    const handle = runner.startTurn(TURN);
    const gesammelt = collect(handle.events);
    await tick();

    gw.notify('sb-p1', { kind: 'message', message: { kind: 'turn-rejected', turnId: 'fremd' } });
    await tick();
    expect(gw.sent.some((m) => m.kind === 'shutdown')).toBe(false);

    // Turn reguläer beenden, damit der Generator endet.
    gw.emitEvent('sb-p1', firstTurnId(gw), { type: 'turn-completed', sessionId: 's' });
    await gesammelt;
  });
});
