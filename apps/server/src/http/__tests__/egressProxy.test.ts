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
  // Für die Tunnel-Mechanik wird die Zielprüfung injiziert — sonst blockte
  // die Policy den lokalen Fake-Upstream (127.0.0.1) zu Recht. Die Policy
  // selbst prüfen die Tests weiter unten gegen den ungefilterten Proxy.
  proxy = startEgressProxy({
    port: 0,
    verifyToken: (t) => (t === TOKEN ? { sandbox: 'test' } : null),
    checkTarget: async (host) => ({ ok: true, address: host }),
  });
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

/**
 * F3: Ohne Zielprüfung tunnelt der Proxy alles, was der HOST erreicht — der
 * Agent besitzt die Credentials per Design. Diese Suite fährt bewusst OHNE
 * injizierte Prüfung, also gegen die echte Policy.
 */
describe('EgressProxy — Zielpolicy (F3)', () => {
  let guarded: EgressProxyHandle;

  beforeAll(() => {
    guarded = startEgressProxy({
      port: 0,
      verifyToken: (t) => (t === TOKEN ? { sandbox: 'test' } : null),
    });
  });
  afterAll(() => guarded.stop());

  function rawTo(port: number, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = '';
      void Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          open(s): void {
            s.write(payload);
          },
          data(_s, chunk): void {
            buffer += new TextDecoder().decode(chunk);
          },
          close(): void {
            resolve(buffer);
          },
          error(_s, err): void {
            reject(err);
          },
        },
      });
      setTimeout(() => resolve(buffer), 3000);
    });
  }

  const auth = (): string => Buffer.from(`mv:${TOKEN}`).toString('base64');

  test('CONNECT auf den Loopback des Hosts wird abgelehnt', async () => {
    const target = `127.0.0.1:${upstream.port}`;
    const out = await rawTo(
      guarded.port,
      `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth()}\r\n\r\n` +
        `GET /tunnel-test HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`,
    );
    expect(out).toContain('403');
    expect(out).not.toContain('upstream-ok');
  });

  test('CONNECT auf einen nicht erlaubten Port wird abgelehnt', async () => {
    const out = await rawTo(
      guarded.port,
      `CONNECT example.com:22 HTTP/1.1\r\nHost: example.com:22\r\nProxy-Authorization: Basic ${auth()}\r\n\r\n`,
    );
    expect(out).toContain('403');
  });

  test('absolute-form auf den Loopback wird abgelehnt', async () => {
    const out = await rawTo(
      guarded.port,
      `GET http://127.0.0.1:${upstream.port}/plain HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${upstream.port}\r\nProxy-Authorization: Basic ${auth()}\r\nConnection: close\r\n\r\n`,
    );
    expect(out).toContain('403');
    expect(out).not.toContain('upstream-ok');
  });

  /**
   * Der Scan hat diesen Smuggling-Kandidaten nur deshalb widerlegt, weil F3
   * demselben Angreifer ohnehin einen freien Tunnel gab. Mit der Policy wird
   * er scharf — deshalb gehört die Kopfprüfung in dasselbe Paket.
   */
  test('nacktes LF im Kopf wird abgelehnt, keine zweite Request-Line', async () => {
    const out = await rawTo(
      guarded.port,
      `CONNECT example.com:443 HTTP/1.1\nProxy-Authorization: Basic ${auth()}\n` +
        `CONNECT 127.0.0.1:${upstream.port} HTTP/1.1\r\n\r\n`,
    );
    expect(out).toContain('400');
    expect(out).not.toContain('upstream-ok');
  });

  test('kaputte Request-Line wird abgelehnt', async () => {
    const out = await rawTo(
      guarded.port,
      `CONNECT example.com:443\r\nProxy-Authorization: Basic ${auth()}\r\n\r\n`,
    );
    expect(out).toContain('400');
  });
});

/**
 * Bytes, die eintreffen, WÄHREND die asynchrone Zielprüfung (DNS + Policy)
 * noch läuft, landeten in state.buf und wurden dort als neuer Request-Kopf
 * geparst — statt für den Upstream gepuffert zu werden. Kommt der Body in
 * einem eigenen TCP-Segment (bei POST der Normalfall), antwortete der Proxy
 * mit 400 Bad Request. Der Fehler trat nur sporadisch auf, weil er vom
 * Segment-Timing abhängt.
 */
describe('EgressProxy — Bytes während der Zielprüfung', () => {
  let echo: ReturnType<typeof Bun.serve>;
  let langsam: EgressProxyHandle;

  beforeAll(() => {
    echo = Bun.serve({
      port: 0,
      fetch: async (req) => new Response(`gelesen:${await req.text()}`),
    });
    langsam = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      // Langsame Prüfung: öffnet das Zeitfenster verlässlich.
      checkTarget: async (host) => {
        await Bun.sleep(60);
        return { ok: true, address: host };
      },
    });
  });

  afterAll(() => {
    echo.stop(true);
    langsam.stop();
  });

  test('ein nachgereichter POST-Body geht nicht verloren', async () => {
    const koerper = 'hallo-welt';
    const kopf =
      `POST http://127.0.0.1:${echo.port}/ HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${echo.port}\r\n` +
      `Content-Length: ${koerper.length}\r\n` +
      'Connection: close\r\n\r\n';

    const antwort = await new Promise<string>((resolve, reject) => {
      let puffer = '';
      Bun.connect({
        hostname: '127.0.0.1',
        port: langsam.port,
        socket: {
          open(s) {
            s.write(kopf);
            // Body erst schicken, wenn die Zielprüfung sicher noch läuft.
            setTimeout(() => s.write(koerper), 15);
          },
          data(_s, chunk) {
            puffer += new TextDecoder().decode(chunk);
          },
          close() {
            resolve(puffer);
          },
          error(_s, err) {
            reject(err);
          },
        },
      }).catch(reject);
      setTimeout(() => resolve(puffer), 4000);
    });

    expect(antwort).not.toContain('400 Bad Request');
    expect(antwort).toContain('gelesen:hallo-welt');
  });
});
