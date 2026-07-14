import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createAnthropicProxy,
  injectThinkingDisplay,
  PROXY_TOKEN_HEADER,
  type AnthropicProxyConfig,
} from '../anthropicProxy';

interface SeenRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
}

let upstream: ReturnType<typeof Bun.serve>;
const seen: SeenRequest[] = [];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      seen.push({
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers.entries()),
        body: await request.text(),
      });
      return Response.json({ ok: true });
    },
  });
});

afterAll(() => {
  upstream.stop(true);
});

function makeProxy(overrides: Partial<AnthropicProxyConfig> = {}) {
  return createAnthropicProxy({
    upstreamUrl: `http://localhost:${upstream.port}`,
    proxyToken: 'geheim-123',
    oauthToken: 'test-oauth-token',
    apiKey: null,
    ...overrides,
  });
}

function vmRequest(headers: Record<string, string> = {}, body?: string): Request {
  return new Request('http://host.microsandbox.internal:4000/anthropic/v1/messages?beta=true', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [PROXY_TOKEN_HEADER]: 'geheim-123',
      ...headers,
    },
    body: body ?? JSON.stringify({ model: 'claude', max_tokens: 1 }),
  });
}

describe('Anthropic-Credential-Proxy (B5c, R10/NFR)', () => {
  test('injiziert den OAuth-Token und reicht Pfad/Body durch', async () => {
    const proxy = makeProxy();
    seen.length = 0;

    const response = await proxy(vmRequest(), '/v1/messages?beta=true');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const request = seen[0];
    expect(request?.path).toBe('/v1/messages?beta=true');
    expect(request?.headers['authorization']).toBe('Bearer test-oauth-token');
    expect(request?.headers['x-api-key']).toBeUndefined();
    expect(request?.body).toContain('"max_tokens":1');
  });

  test('ersetzt Auth-Header aus der VM und leakt das Proxy-Secret nicht', async () => {
    const proxy = makeProxy();
    seen.length = 0;

    await proxy(
      vmRequest({ authorization: 'Bearer vm-fake', 'x-api-key': 'vm-dummy-key' }),
      '/v1/messages?beta=true',
    );

    const request = seen[0];
    expect(request?.headers['authorization']).toBe('Bearer test-oauth-token');
    expect(request?.headers['x-api-key']).toBeUndefined();
    expect(request?.headers[PROXY_TOKEN_HEADER]).toBeUndefined();
  });

  test('setzt bei OAuth-Token das anthropic-beta-Flag und erhält bestehende Betas', async () => {
    const proxy = makeProxy();
    seen.length = 0;

    await proxy(vmRequest({ 'anthropic-beta': 'prompt-caching-2024-07-31' }), '/v1/messages');
    const beta = seen[0]?.headers['anthropic-beta'] ?? '';
    expect(beta).toContain('oauth-2025-04-20');
    expect(beta).toContain('prompt-caching-2024-07-31');
  });

  test('reicht das accept-encoding der VM nicht durch (fetch verhandelt selbst)', async () => {
    const proxy = makeProxy();
    seen.length = 0;
    await proxy(vmRequest({ 'accept-encoding': 'br;q=1.0, custom-vm-encoding' }), '/v1/messages');
    // Bun's fetch setzt sein eigenes accept-encoding und dekomprimiert selbst —
    // entscheidend ist, dass der VM-Wert nicht durchsickert (Antwortpfad wird
    // im gzip-Roundtrip-Test abgesichert).
    expect(seen[0]?.headers['accept-encoding'] ?? '').not.toContain('custom-vm-encoding');
  });

  test('nutzt den API-Key, wenn kein OAuth-Token konfiguriert ist', async () => {
    const proxy = makeProxy({ oauthToken: null, apiKey: 'sk-test-key' });
    seen.length = 0;

    await proxy(vmRequest(), '/v1/messages');
    const request = seen[0];
    expect(request?.headers['x-api-key']).toBe('sk-test-key');
    expect(request?.headers['authorization']).toBeUndefined();
  });

  test('weist Requests ohne gültigen Proxy-Token ab (401), Upstream bleibt unberührt', async () => {
    const proxy = makeProxy();
    seen.length = 0;

    const wrong = await proxy(vmRequest({ [PROXY_TOKEN_HEADER]: 'falsch' }), '/v1/messages');
    const missing = await proxy(
      new Request('http://x/anthropic/v1/messages', { method: 'POST', body: '{}' }),
      '/v1/messages',
    );

    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('meldet 503 mit klarer Meldung, wenn keine Credentials konfiguriert sind', async () => {
    const proxy = makeProxy({ oauthToken: null, apiKey: null });
    const response = await proxy(vmRequest(), '/v1/messages');
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});

describe('Modell-Routing (Modellwahl pro Chat: Claude API vs. lokaler Router)', () => {
  // Zweiter Upstream: der lokale Shim/Router (LiteLLM) für qwen-Modelle.
  let localUpstream: ReturnType<typeof Bun.serve>;
  const localSeen: SeenRequest[] = [];

  beforeAll(() => {
    localUpstream = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        localSeen.push({
          path: url.pathname + url.search,
          headers: Object.fromEntries(request.headers.entries()),
          body: await request.text(),
        });
        return Response.json({ ok: true, upstream: 'local' });
      },
    });
  });

  afterAll(() => {
    localUpstream.stop(true);
  });

  function makeRoutingProxy(overrides: Partial<AnthropicProxyConfig> = {}) {
    return makeProxy({
      localUpstreamUrl: `http://localhost:${localUpstream.port}`,
      localApiKey: 'local-key',
      ...overrides,
    });
  }

  function bodyWithModel(model: string): string {
    return JSON.stringify({ model, max_tokens: 1, messages: [] });
  }

  test('claude-* Modelle gehen an den Anthropic-Upstream mit OAuth-Token', async () => {
    const proxy = makeRoutingProxy();
    seen.length = 0;
    localSeen.length = 0;

    await proxy(vmRequest({}, bodyWithModel('claude-sonnet-5')), '/v1/messages');
    expect(seen).toHaveLength(1);
    expect(localSeen).toHaveLength(0);
    expect(seen[0]?.headers['authorization']).toBe('Bearer test-oauth-token');
  });

  test('qwen-Modelle gehen an den lokalen Router mit dessen API-Key', async () => {
    const proxy = makeRoutingProxy();
    seen.length = 0;
    localSeen.length = 0;

    const response = await proxy(vmRequest({}, bodyWithModel('qwen3.6-coder')), '/v1/messages');
    expect(await response.json()).toEqual({ ok: true, upstream: 'local' });
    expect(seen).toHaveLength(0);
    expect(localSeen).toHaveLength(1);
    expect(localSeen[0]?.headers['x-api-key']).toBe('local-key');
    // Claude-Credentials dürfen NICHT an den lokalen Router leaken.
    expect(localSeen[0]?.headers['authorization']).toBeUndefined();
  });

  test('claude-* ohne Claude-Credentials fällt auf den lokalen Router zurück (Hilfsmodelle)', async () => {
    // Claude Code ruft intern claude-haiku-* Hilfsmodelle auf, auch wenn der
    // Chat auf qwen steht — ohne Claude-Zugang beantwortet die der lokale Router.
    const proxy = makeRoutingProxy({ oauthToken: null, apiKey: null });
    seen.length = 0;
    localSeen.length = 0;

    const response = await proxy(vmRequest({}, bodyWithModel('claude-haiku-4-5')), '/v1/messages');
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(0);
    expect(localSeen).toHaveLength(1);
  });

  test('Requests ohne Modell (z. B. GET) gehen an den Claude-Upstream, wenn Credentials da sind', async () => {
    const proxy = makeRoutingProxy();
    seen.length = 0;
    localSeen.length = 0;

    const request = new Request('http://host/anthropic/v1/models', {
      method: 'GET',
      headers: { [PROXY_TOKEN_HEADER]: 'geheim-123' },
    });
    await proxy(request, '/v1/models');
    expect(seen).toHaveLength(1);
    expect(localSeen).toHaveLength(0);
  });

  test('Zusatz-Routen (OpenRouter-Stil) matchen vor den Default-Routen', async () => {
    const extraUpstream = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const headers = Object.fromEntries(request.headers.entries());
        await request.text();
        return Response.json({ ok: true, upstream: 'extra', key: headers['x-api-key'] ?? null });
      },
    });
    try {
      const proxy = makeRoutingProxy({
        extraRoutes: [
          {
            prefix: 'gpt-',
            upstreamUrl: `http://localhost:${extraUpstream.port}`,
            apiKey: 'sk-or-123',
          },
        ],
      });
      seen.length = 0;
      localSeen.length = 0;

      const response = await proxy(vmRequest({}, bodyWithModel('gpt-5')), '/v1/messages');
      expect(await response.json()).toEqual({ ok: true, upstream: 'extra', key: 'sk-or-123' });
      expect(seen).toHaveLength(0);
      expect(localSeen).toHaveLength(0);
    } finally {
      extraUpstream.stop(true);
    }
  });
});

describe('Thinking-Text sichtbar machen (display: summarized)', () => {
  test('ergänzt display:"summarized" bei aktivem Thinking', () => {
    const body = JSON.stringify({
      model: 'claude',
      max_tokens: 1000,
      thinking: { type: 'enabled', budget_tokens: 10_000 },
    });
    const out = JSON.parse(injectThinkingDisplay(body));
    expect(out.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 10_000,
      display: 'summarized',
    });
    // Der Rest des Bodys bleibt unangetastet.
    expect(out.model).toBe('claude');
    expect(out.max_tokens).toBe(1000);
  });

  test('lässt einen Body ohne Thinking unverändert', () => {
    const body = JSON.stringify({ model: 'claude', max_tokens: 1 });
    expect(injectThinkingDisplay(body)).toBe(body);
  });

  test('lässt deaktiviertes Thinking unverändert', () => {
    const body = JSON.stringify({ model: 'claude', thinking: { type: 'disabled' } });
    const out = JSON.parse(injectThinkingDisplay(body));
    expect(out.thinking).toEqual({ type: 'disabled' });
  });

  test('ergänzt display auch bei adaptivem Thinking (die On-Form auf Opus 4.8)', () => {
    // Opus 4.8 kennt nur adaptive als On-Modus (enabled+budget_tokens => 400).
    // Aktiviert Claude Code Thinking, kommt {type:"adaptive"} — das MUSS greifen.
    const body = JSON.stringify({ model: 'claude-opus-4-8', thinking: { type: 'adaptive' } });
    const out = JSON.parse(injectThinkingDisplay(body));
    expect(out.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  test('hebt ein explizites display:"omitted" auf "summarized" an (wir wollen den Text)', () => {
    // Claude Code sendet Thinking evtl. mit display:"omitted" — dann streamt die
    // API keinen Text. Genau das heben wir an, sonst liefe die Injektion ins Leere.
    const body = JSON.stringify({
      thinking: { type: 'enabled', budget_tokens: 5, display: 'omitted' },
    });
    const out = JSON.parse(injectThinkingDisplay(body));
    expect(out.thinking.display).toBe('summarized');
  });

  test('lässt ein bereits gesetztes display:"summarized" unverändert (idempotent)', () => {
    const body = JSON.stringify({
      thinking: { type: 'enabled', budget_tokens: 5, display: 'summarized' },
    });
    expect(injectThinkingDisplay(body)).toBe(body);
  });

  test('reicht ungültiges JSON unverändert durch (darf nie werfen)', () => {
    expect(injectThinkingDisplay('nicht-json{')).toBe('nicht-json{');
    expect(injectThinkingDisplay('')).toBe('');
  });

  test('End-to-End: der Upstream sieht den ergänzten Body', async () => {
    const proxy = makeProxy();
    seen.length = 0;
    const body = JSON.stringify({
      model: 'claude',
      max_tokens: 1,
      thinking: { type: 'enabled', budget_tokens: 8000 },
    });
    await proxy(vmRequest({}, body), '/v1/messages');
    const forwarded = JSON.parse(seen[0]?.body ?? '{}');
    expect(forwarded.thinking.display).toBe('summarized');
  });
});

describe('Antwortpfad — die Live-Bugs von 2026-07-04 dürfen nie zurückkommen', () => {
  test('gzip-Upstream: Antwort ist lesbar, kein content-encoding-Mismatch (ZlibError)', async () => {
    // Upstream, der IMMER komprimiert — auch wenn accept-encoding gestrippt wurde.
    const gzipUpstream = Bun.serve({
      port: 0,
      fetch: () => {
        const body = Bun.gzipSync(JSON.stringify({ ok: true, komprimiert: true }));
        return new Response(body, {
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        });
      },
    });
    try {
      const proxy = makeProxy({ upstreamUrl: `http://localhost:${gzipUpstream.port}` });
      const response = await proxy(vmRequest(), '/v1/messages');

      // Der Body muss als Klartext lesbar sein …
      expect(await response.json()).toEqual({ ok: true, komprimiert: true });
      // … und es darf KEIN content-encoding-Header übrig bleiben, der den
      // Client (Claude Code in der VM) zu einer zweiten Dekompression verleitet.
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('content-length')).toBeNull();
    } finally {
      gzipUpstream.stop(true);
    }
  });

  test('SSE-Streaming wird inkrementell durchgereicht (Claude streamt!)', async () => {
    const sseUpstream = Bun.serve({
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('event: message_start\ndata: {"a":1}\n\n'));
            await Bun.sleep(20);
            controller.enqueue(encoder.encode('event: message_stop\ndata: {"b":2}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      const proxy = makeProxy({ upstreamUrl: `http://localhost:${sseUpstream.port}` });
      const response = await proxy(vmRequest(), '/v1/messages');

      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      // Erster Chunk muss ankommen, BEVOR der Stream fertig ist (echtes Streaming).
      const first = await reader?.read();
      const firstText = new TextDecoder().decode(first?.value);
      expect(firstText).toContain('message_start');
      let rest = '';
      for (;;) {
        const chunk = await reader?.read();
        if (!chunk || chunk.done) break;
        rest += new TextDecoder().decode(chunk.value);
      }
      expect(rest).toContain('message_stop');
    } finally {
      sseUpstream.stop(true);
    }
  });

  test('Keepalive: hält den SSE-Stream in Sende-Pausen warm (gegen NAT/Idle-Timeout-Kappung)', async () => {
    // Upstream mit einer langen Pause zwischen zwei Frames — genau die Situation
    // (langsames lokales Modell: Prefill/Denken ohne Tokens), in der die
    // VM→Host-Verbindung sonst als idle gekappt wird ("Connection closed mid-response").
    const gapUpstream = Bun.serve({
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode('event: message_start\ndata: {"a":1}\n\n'));
            await Bun.sleep(150); // > 3× keepAliveMs → mehrere Keepalives erwartet
            controller.enqueue(encoder.encode('event: message_stop\ndata: {"b":2}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    try {
      const proxy = makeProxy({
        upstreamUrl: `http://localhost:${gapUpstream.port}`,
        keepAliveMs: 40,
      });
      const response = await proxy(vmRequest(), '/v1/messages');
      const full = await response.text();
      // Original-Frames unversehrt …
      expect(full).toContain('event: message_start');
      expect(full).toContain('event: message_stop');
      // … und in der Pause wurde mindestens ein SSE-Kommentar-Keepalive injiziert.
      expect(full).toContain(': keepalive');
      // Der Keepalive liegt an der Frame-Grenze, zerstört also kein Event.
      expect(full.indexOf(': keepalive')).toBeGreaterThan(full.indexOf('message_start'));
      expect(full.indexOf(': keepalive')).toBeLessThan(full.indexOf('message_stop'));
    } finally {
      gapUpstream.stop(true);
    }
  });

  test('Keepalive: nicht-SSE-Antworten (einzelnes JSON) bleiben unangetastet', async () => {
    // Der geteilte Upstream liefert application/json → kein Keepalive, exakt der Body.
    const proxy = makeProxy({ keepAliveMs: 40 });
    const response = await proxy(vmRequest(), '/v1/messages');
    expect(await response.json()).toEqual({ ok: true });
  });

  test('Fehler-Status und retry-after werden durchgereicht (SDK-Retry braucht sie)', async () => {
    const rateLimitUpstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }), {
          status: 429,
          headers: { 'retry-after': '7', 'content-type': 'application/json' },
        }),
    });
    try {
      const proxy = makeProxy({ upstreamUrl: `http://localhost:${rateLimitUpstream.port}` });
      const response = await proxy(vmRequest(), '/v1/messages');
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('7');
    } finally {
      rateLimitUpstream.stop(true);
    }
  });
});
