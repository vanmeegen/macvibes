import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { AGENT_GATEWAY_PATH, AgentGateway } from '../agentGateway';
import type { GatewayNotification } from '../agentGateway';

const TOKEN = 'geheim-123';

interface Harness {
  gateway: AgentGateway;
  server: Server;
  url: (sandbox: string, token?: string) => string;
}

const servers: Server[] = [];
const sockets: WebSocket[] = [];

function makeHarness(): Harness {
  const gateway = new AgentGateway({ token: TOKEN });
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
      openSocket(`ws://localhost:${h.server.port}${AGENT_GATEWAY_PATH}?token=${TOKEN}`),
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
  });

  test('waitForConnection läuft in einen Timeout, wenn niemand kommt', async () => {
    const h = makeHarness();
    await expect(h.gateway.waitForConnection('sb-leer', 50)).rejects.toThrow();
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
