import { describe, expect, test } from 'bun:test';
import { GatewayConnection, type GatewaySocket } from '../gatewayConnection';
import type { DaemonToHostMessage } from '../protocol';

/** Steuerbarer Socket: Tests lösen open/message/close selbst aus. */
class FakeSocket implements GatewaySocket {
  readyState = 0;
  readonly sent: DaemonToHostMessage[] = [];
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as DaemonToHostMessage);
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  closeCalls = 0;
  close(): void {
    this.closeCalls += 1;
  }
  fire(type: 'open' | 'message' | 'close' | 'error', data?: unknown): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function setup(sessionOverrides: Partial<Parameters<typeof build>[0]> = {}) {
  return build(sessionOverrides);
}

function build(overrides: { startTurn?: (message: { turnId: string }) => void }) {
  const sockets: FakeSocket[] = [];
  const reconnects: Array<{ delayMs: number; run: () => void }> = [];
  const intervals: Array<{ everyMs: number; run: () => void; cancelled: boolean }> = [];
  const calls: string[] = [];
  let shutdowns = 0;
  const connection = new GatewayConnection({
    url: 'ws://host/agent',
    session: {
      startTurn: (message) => {
        calls.push(`startTurn:${message.turnId}`);
        overrides.startTurn?.(message);
      },
      interrupt: (turnId) => void calls.push(`interrupt:${turnId}`),
      abandonTurn: () => void calls.push('abandonTurn'),
    },
    onShutdown: () => {
      shutdowns += 1;
    },
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimeout: (run, delayMs) => void reconnects.push({ delayMs, run }),
    setInterval: (run, everyMs) => {
      const entry = { everyMs, run, cancelled: false };
      intervals.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    log: () => {},
    logError: () => {},
  });
  connection.start();
  return {
    connection,
    sockets,
    reconnects,
    intervals,
    calls,
    shutdowns: () => shutdowns,
    current: () => sockets[sockets.length - 1] as FakeSocket,
  };
}

const startTurn = (turnId: string): string =>
  JSON.stringify({ kind: 'start-turn', turnId, prompt: 'hi', model: 'm', resumeSessionId: null });

/**
 * Die Verbindungslogik des Daemons lief als Top-Level-Skript in main.ts und war
 * damit untestbar — ausgerechnet die Teile, die gegen msb-NAT härten
 * (Quittung vor dem Start, Heartbeat, Reconnect, Turn-Freigabe beim Abriss).
 */
describe('GatewayConnection — Daemon-Seite der Host-Verbindung', () => {
  test('meldet sich nach dem Verbinden mit ready und hält den NAT-Flow per Ping warm', () => {
    const t = setup();
    t.current().fire('open');
    expect(t.current().sent).toEqual([{ kind: 'ready' }]);
    expect(t.intervals).toHaveLength(1);
    expect(t.intervals[0]?.everyMs).toBe(15_000);
    t.intervals[0]?.run();
    expect(t.current().sent).toEqual([{ kind: 'ready' }, { kind: 'ping' }]);
  });

  test('quittiert start-turn, BEVOR die Session den Turn startet', () => {
    const order: string[] = [];
    const t = setup({ startTurn: () => order.push('startTurn') });
    t.current().fire('open');
    const original = t.current().send.bind(t.current());
    t.current().send = (data: string): void => {
      order.push((JSON.parse(data) as { kind: string }).kind);
      original(data);
    };
    t.current().fire('message', startTurn('t1'));
    expect(order).toEqual(['turn-started', 'startTurn']);
    expect(t.calls).toEqual(['startTurn:t1']);
  });

  test('scheitert der Turn-Start, erfährt es der Host als error + turn-aborted', () => {
    const t = setup({
      startTurn: () => {
        throw new Error('SDK kaputt');
      },
    });
    t.current().fire('open');
    t.current().fire('message', startTurn('t2'));
    const events = t.current().sent.filter((m) => m.kind === 'event');
    expect(events).toEqual([
      {
        kind: 'event',
        turnId: 't2',
        event: { type: 'error', message: 'Daemon-Kommando fehlgeschlagen: Error: SDK kaputt' },
      },
      { kind: 'event', turnId: 't2', event: { type: 'turn-aborted' } },
    ]);
  });

  test('interrupt und shutdown landen bei Session bzw. Prozess, pong und Müll werden ignoriert', () => {
    const t = setup();
    t.current().fire('open');
    t.current().fire('message', JSON.stringify({ kind: 'interrupt', turnId: 't3' }));
    t.current().fire('message', JSON.stringify({ kind: 'pong' }));
    t.current().fire('message', 'kein json');
    expect(t.calls).toEqual(['interrupt:t3']);
    expect(t.shutdowns()).toBe(0);
    t.current().fire('message', JSON.stringify({ kind: 'shutdown' }));
    expect(t.shutdowns()).toBe(1);
  });

  test('Abriss: Ping endet, der Turn wird freigegeben, Reconnect mit wachsendem Backoff bis 8 s', () => {
    const t = setup();
    t.current().fire('open');
    t.current().fire('close');
    expect(t.intervals[0]?.cancelled).toBe(true);
    // Ohne abandonTurn bliebe die Notwehr-Sperre der Session für immer zu.
    expect(t.calls).toEqual(['abandonTurn']);
    expect(t.reconnects.map((r) => r.delayMs)).toEqual([500]);

    // Jeder weitere Fehlversuch (Verbindung kommt nie zustande) verdoppelt.
    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      t.reconnects[t.reconnects.length - 1]?.run();
      t.current().fire('close');
      delays.push(t.reconnects[t.reconnects.length - 1]?.delayMs ?? -1);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  test('nach einem erfolgreichen Verbinden beginnt der Backoff wieder vorn', () => {
    const t = setup();
    t.current().fire('close'); // 500
    t.reconnects[0]?.run();
    t.current().fire('close'); // 1000
    t.reconnects[1]?.run();
    t.current().fire('open');
    t.current().fire('close');
    expect(t.reconnects.map((r) => r.delayMs)).toEqual([500, 1000, 500]);
  });

  test('send() liefert false statt zu werfen, solange keine Verbindung offen ist', () => {
    const t = setup();
    expect(t.connection.send({ kind: 'ping' })).toBe(false);
    t.current().fire('open');
    expect(t.connection.send({ kind: 'preview-status', status: 'ready' })).toBe(true);
    t.current().fire('close');
    expect(t.connection.send({ kind: 'ping' })).toBe(false);
  });
});

/**
 * B4 (Härtung 2026-11): Verschluckt das VM-Netz den Abriss (kein FIN/RST),
 * sieht der Daemon kein `close` — er verband sich nicht neu und gab den Turn
 * nicht frei. Jeder Turn lief in den Timeout des Hosts, bis der TCP-Stack der
 * VM nach Minuten aufgab. Die Pings gingen ins Leere, ihre Antworten wurden
 * nie ausgewertet.
 */
describe('Pong-Wächter: eine stumme Verbindung wird verworfen', () => {
  test('nach zwei unbeantworteten Pings: Turn freigeben, Socket schließen, neu verbinden', () => {
    const t = setup();
    t.current().fire('open');
    const stumm = t.current();
    const ping = t.intervals[0]?.run as () => void;

    ping(); // 1. Ping, noch keine Antwort fällig
    ping(); // 2. Ping, der erste ist unbeantwortet
    expect(t.reconnects).toHaveLength(0);
    ping(); // zwei unbeantwortet → verwerfen

    expect(stumm.closeCalls).toBe(1);
    expect(t.calls).toEqual(['abandonTurn']);
    expect(t.intervals[0]?.cancelled).toBe(true);
    expect(t.reconnects).toHaveLength(1);
    t.reconnects[0]?.run();
    expect(t.sockets).toHaveLength(2);
  });

  test('ein Pong setzt den Zähler zurück', () => {
    const t = setup();
    t.current().fire('open');
    const ping = t.intervals[0]?.run as () => void;
    for (let i = 0; i < 6; i++) {
      ping();
      t.current().fire('message', JSON.stringify({ kind: 'pong' }));
    }
    expect(t.current().closeCalls).toBe(0);
    expect(t.reconnects).toHaveLength(0);
  });

  test('das späte close-Ereignis des verworfenen Sockets löst keinen zweiten Reconnect aus', () => {
    const t = setup();
    t.current().fire('open');
    const stumm = t.current();
    const ping = t.intervals[0]?.run as () => void;
    ping();
    ping();
    ping();
    stumm.fire('close');
    expect(t.reconnects).toHaveLength(1);
    expect(t.calls).toEqual(['abandonTurn']);
  });

  test('eine Nachricht des verworfenen Sockets wird nicht mehr ausgeführt', () => {
    const t = setup();
    t.current().fire('open');
    const stumm = t.current();
    const ping = t.intervals[0]?.run as () => void;
    ping();
    ping();
    ping();
    stumm.fire('message', startTurn('spät'));
    expect(t.calls).toEqual(['abandonTurn']);
  });
});
