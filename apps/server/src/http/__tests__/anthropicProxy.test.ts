import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createAnthropicProxy,
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
