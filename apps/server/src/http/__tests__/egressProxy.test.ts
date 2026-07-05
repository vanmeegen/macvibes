import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startEgressProxy, type EgressProxyHandle } from '../egressProxy';

/**
 * Egress-Proxy (CONNECT + absolute-form GET): microsandbox' Regel-Engine
 * blockt jeglichen Public-Egress, sobald Regeln gesetzt sind — nur der
 * Host-Gateway bleibt erreichbar. Der Agent (claude, bun install) routet
 * deshalb via HTTP(S)_PROXY über diesen Proxy auf dem Host.
 */

let upstream: ReturnType<typeof Bun.serve>;
let proxy: EgressProxyHandle;
const TOKEN = 'egress-secret-1';

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch: (req) => new Response(`upstream-ok ${new URL(req.url).pathname}`),
  });
  proxy = startEgressProxy({ port: 0, token: TOKEN });
});

afterAll(() => {
  upstream.stop(true);
  proxy.stop();
});

function connectRaw(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const socket = Bun.connect({
      hostname: '127.0.0.1',
      port: proxy.port,
      socket: {
        open(s) {
          s.write(payload);
        },
        data(_s, chunk) {
          buffer += new TextDecoder().decode(chunk);
        },
        close() {
          resolve(buffer);
        },
        error(_s, err) {
          reject(err);
        },
      },
    });
    void socket;
    setTimeout(() => resolve(buffer), 3000);
  });
}

describe('EgressProxy (CONNECT-Tunnel für VM-Traffic)', () => {
  test('CONNECT mit gültigem Token tunnelt TCP zum Ziel', async () => {
    const target = `127.0.0.1:${upstream.port}`;
    const auth = Buffer.from(`mv:${TOKEN}`).toString('base64');
    const out = await connectRaw(
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n` +
        // Nach dem 200 des Proxys geht die HTTP-Anfrage durch den Tunnel:
        `GET /tunnel-test HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`,
    );
    expect(out).toContain('200'); // CONNECT established
    expect(out).toContain('upstream-ok /tunnel-test');
  });

  test('CONNECT ohne/mit falschem Token wird abgewiesen (407)', async () => {
    const target = `127.0.0.1:${upstream.port}`;
    const out = await connectRaw(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    expect(out).toContain('407');
    expect(out).not.toContain('upstream-ok');
  });

  test('absolute-form GET (http_proxy-Stil) wird weitergereicht', async () => {
    const auth = Buffer.from(`mv:${TOKEN}`).toString('base64');
    const out = await connectRaw(
      `GET http://127.0.0.1:${upstream.port}/plain HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${upstream.port}\r\nProxy-Authorization: Basic ${auth}\r\nConnection: close\r\n\r\n`,
    );
    expect(out).toContain('upstream-ok /plain');
  });
});
