import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { createVmTokenRegistry } from '../../core/vmTokens';
import { AGENT_GATEWAY_PATH, AgentGateway } from '../agentGateway';
import type { GatewayNotification, GatewaySocketData } from '../agentGateway';

// Ein Token PRO Sandbox (F4/F12) — die Registry ist jetzt die Auth-Quelle.
const tokens = createVmTokenRegistry();
const TOKEN = tokens.mint('sb-1');
const TOKEN_SB2 = tokens.mint('sb-2');

interface Harness {
  gateway: AgentGateway;
  server: Server<GatewaySocketData>;
  url: (sandbox: string, token?: string) => string;
}

const servers: Server<GatewaySocketData>[] = [];
const sockets: WebSocket[] = [];

function makeHarness(): Harness {
  const gateway = new AgentGateway({ tokens });
  const server = Bun.serve({
    port: 0,
    fetch: (request, srv) => {
      const url = new URL(request.url);
      if (url.pathname === AGENT_GATEWAY_PATH) {
        return gateway.handleUpgrade(request, srv);
      }
      return new Response('nicht hier', { status: 404 });
    },
    websocket: gateway.websocket,
  });
  servers.push(server);
  return {
    gateway,
    server,
    url: (sandbox, token = TOKEN) =>
      `ws://localhost:${server.port}${AGENT_GATEWAY_PATH}?sandbox=${sandbox}&token=${token}`,
  };
}

function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('close', (e) => reject(new Error(`geschlossen: ${e.code}`)));
    ws.addEventListener('error', () => reject(new Error('WS-Fehler')));
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.addEventListener('close', () => resolve()));
}

afterEach(() => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      // Testaufräumen — Socket ggf. schon zu.
    }
  }
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe('AgentGateway', () => {
  test('Daemon mit korrektem Token verbindet sich; isConnected + waitForConnection greifen', async () => {
    const h = makeHarness();
    expect(h.gateway.isConnected('sb-1')).toBe(false);

    const waiting = h.gateway.waitForConnection('sb-1', 2000);
    await openSocket(h.url('sb-1'));
    await waiting;
    expect(h.gateway.isConnected('sb-1')).toBe(true);
  });

  test('falsches Token wird abgewiesen (Verbindung kommt nie zustande)', async () => {
    const h = makeHarness();
    await expect(openSocket(h.url('sb-1', 'falsch'))).rejects.toThrow();
    expect(h.gateway.isConnected('sb-1')).toBe(false);
  });

  test('fehlender sandbox-Parameter wird abgewiesen', async () => {
    const h = makeHarness();
    await expect(
      openSocket(
        `ws://localhost:${h.server.port}${AGENT_GATEWAY_PATH}?token=${TOKEN}&sandbox=sb-2`,
      ),
    ).rejects.toThrow();
  });

  test('Nachrichten des Daemons erreichen Abonnenten der Sandbox — valide geparst', async () => {
    const h = makeHarness();
    const received: GatewayNotification[] = [];
    h.gateway.subscribe('sb-1', (n) => received.push(n));

    const ws = await openSocket(h.url('sb-1'));
    ws.send(
      JSON.stringify({
        kind: 'event',
        turnId: 't-1',
        event: { type: 'text-delta', text: 'Hallo' },
      }),
    );
    ws.send('{ kaputt'); // wird verworfen, kein Listener-Aufruf

    await Bun.sleep(50);
    expect(received).toEqual([
      {
        kind: 'message',
        message: { kind: 'event', turnId: 't-1', event: { type: 'text-delta', text: 'Hallo' } },
      },
    ]);
  });

  test('send() liefert Kommandos an den Daemon; ohne Verbindung false', async () => {
    const h = makeHarness();
    expect(h.gateway.send('sb-1', { kind: 'interrupt', turnId: 't-0' })).toBe(false);

    const ws = await openSocket(h.url('sb-1'));
    const incoming: string[] = [];
    ws.addEventListener('message', (e) => incoming.push(String(e.data)));

    await h.gateway.waitForConnection('sb-1', 2000);
    const ok = h.gateway.send('sb-1', {
      kind: 'start-turn',
      turnId: 't-1',
      prompt: 'los',
      resumeSessionId: null,
      model: 'claude-sonnet-5',
    });
    expect(ok).toBe(true);

    await Bun.sleep(50);
    expect(incoming).toHaveLength(1);
    expect(JSON.parse(incoming[0]!)).toMatchObject({ kind: 'start-turn', turnId: 't-1' });
  });

  test('Disconnect benachrichtigt Abonnenten und isConnected kippt', async () => {
    const h = makeHarness();
    const received: GatewayNotification[] = [];
    h.gateway.subscribe('sb-1', (n) => received.push(n));

    const ws = await openSocket(h.url('sb-1'));
    await h.gateway.waitForConnection('sb-1', 2000);
    ws.close();
    await Bun.sleep(50);

    expect(h.gateway.isConnected('sb-1')).toBe(false);
    expect(received.at(-1)).toEqual({ kind: 'disconnected' });
  });

  test('Reconnect derselben Sandbox ersetzt die alte Verbindung', async () => {
    const h = makeHarness();
    const received: GatewayNotification[] = [];
    h.gateway.subscribe('sb-1', (n) => received.push(n));
    const first = await openSocket(h.url('sb-1'));
    await h.gateway.waitForConnection('sb-1', 2000);

    const second = await openSocket(h.url('sb-1'));
    await Bun.sleep(50);
    // Alte Verbindung wird serverseitig geschlossen, neue übernimmt.
    await waitForClose(first);
    expect(h.gateway.isConnected('sb-1')).toBe(true);

    const incoming: string[] = [];
    second.addEventListener('message', (e) => incoming.push(String(e.data)));
    h.gateway.send('sb-1', { kind: 'interrupt', turnId: 't-9' });
    await Bun.sleep(50);
    expect(incoming).toHaveLength(1);
    // Der Replace darf KEIN falsches disconnected feuern — sonst bricht ein
    // gerade startender Turn grundlos ab (Live-Befund 2026-07-06).
    expect(received.filter((n) => n.kind === 'disconnected')).toEqual([]);
  });

  test('waitForConnection läuft in einen Timeout, wenn niemand kommt', async () => {
    const h = makeHarness();
    await expect(h.gateway.waitForConnection('sb-leer', 50)).rejects.toThrow();
  });

  test('ping-Heartbeats werden NICHT an Abonnenten durchgereicht', async () => {
    const h = makeHarness();
    const received: GatewayNotification[] = [];
    h.gateway.subscribe('sb-1', (n) => received.push(n));

    const ws = await openSocket(h.url('sb-1'));
    ws.send(JSON.stringify({ kind: 'ping' }));
    ws.send(JSON.stringify({ kind: 'ready' }));
    await Bun.sleep(50);
    expect(received).toEqual([{ kind: 'message', message: { kind: 'ready' } }]);
  });

  test('abbestellte Listener bekommen nichts mehr', async () => {
    const h = makeHarness();
    const received: GatewayNotification[] = [];
    const unsubscribe = h.gateway.subscribe('sb-1', (n) => received.push(n));
    unsubscribe();

    const ws = await openSocket(h.url('sb-1'));
    ws.send(JSON.stringify({ kind: 'ready' }));
    await Bun.sleep(50);
    expect(received).toEqual([]);
  });
});

/**
 * Geordneter Verbindungsabbau für den Daemon-Neustart: nach einem
 * turn-rejected ist die Verbindung LEBENDIG (der Daemon hat gerade gesendet).
 * Der Runner schickt `shutdown` und muss die Verbindung danach loswerden —
 * aber mit Close-Handshake (flusht die gepufferte shutdown-Frame), nicht per
 * terminate() wie `invalidate` (das ist für mutmaßlich TOTE Verbindungen und
 * verwirft ungesendete Frames — der Supervisor bekäme den Neustart nie).
 */
describe('AgentGateway.closeGracefully', () => {
  test('nimmt die Verbindung aus der Registrierung und flusht eine zuvor gesendete Frame', async () => {
    const h = makeHarness();
    const ws = await openSocket(h.url('sb-1'));
    const incoming: string[] = [];
    ws.addEventListener('message', (e) => incoming.push(String(e.data)));
    await h.gateway.waitForConnection('sb-1', 2000);

    expect(h.gateway.send('sb-1', { kind: 'shutdown' })).toBe(true);
    h.gateway.closeGracefully('sb-1');

    // Sofort deregistriert: waitForConnection eines Retrys wartet echt.
    expect(h.gateway.isConnected('sb-1')).toBe(false);
    // Der Close-Handshake erreicht den Client — und die vorher gesendete
    // shutdown-Frame kommt trotz Close noch an (kein terminate-Verwurf).
    await waitForClose(ws);
    expect(incoming.map((raw) => JSON.parse(raw) as unknown)).toContainEqual({ kind: 'shutdown' });
  });

  test('feuert kein falsches disconnected; ein Reconnect registriert danach sauber', async () => {
    const h = makeHarness();
    const received: GatewayNotification[] = [];
    h.gateway.subscribe('sb-1', (n) => received.push(n));
    const first = await openSocket(h.url('sb-1'));
    await h.gateway.waitForConnection('sb-1', 2000);

    h.gateway.closeGracefully('sb-1');
    await waitForClose(first);
    expect(h.gateway.isConnected('sb-1')).toBe(false);
    // Der Runner beendet den Turn selbst (turn-aborted) — ein zusätzliches
    // disconnected wäre ein zweiter, falscher Abbruch (wie bei invalidate).
    expect(received.filter((n) => n.kind === 'disconnected')).toEqual([]);

    // Der neu gestartete Daemon wählt sich frisch ein — genau darauf wartet
    // der chatService-Retry.
    const waiting = h.gateway.waitForConnection('sb-1', 2000);
    const second = await openSocket(h.url('sb-1'));
    await waiting;
    expect(h.gateway.isConnected('sb-1')).toBe(true);
    const incoming: string[] = [];
    second.addEventListener('message', (e) => incoming.push(String(e.data)));
    h.gateway.send('sb-1', { kind: 'interrupt', turnId: 't-neu' });
    await Bun.sleep(50);
    expect(incoming).toHaveLength(1);
  });

  test('ohne registrierte Verbindung ein No-Op', () => {
    const h = makeHarness();
    expect(() => h.gateway.closeGracefully('sb-unbekannt')).not.toThrow();
  });
});

/**
 * F4: Vorher prüfte das Gateway nur das prozessweite Shared Secret — das jede
 * VM besitzt — und übernahm den frei wählbaren sandbox-Parameter als
 * Identität. Eine VM konnte sich damit als fremdes Projekt anmelden, dessen
 * Prompts empfangen und gefälschte Events in fremde Chats schreiben.
 */
describe('Sandbox-Identität kommt aus dem Token (F4)', () => {
  test('fremde Sandbox mit eigenem Token wird abgewiesen', async () => {
    const h = makeHarness();
    await expect(openSocket(h.url('sb-2', TOKEN))).rejects.toThrow();
  });

  test('das eigene Token für die eigene Sandbox geht', async () => {
    const h = makeHarness();
    await expect(openSocket(h.url('sb-2', TOKEN_SB2))).resolves.toBeDefined();
  });

  test('ein widerrufenes Token wird abgewiesen', async () => {
    const eigene = createVmTokenRegistry();
    const token = eigene.mint('sb-x');
    eigene.revoke('sb-x');
    expect(eigene.lookup(token)).toBeNull();
  });
});
