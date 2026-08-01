import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  startEgressProxy,
  flushPending,
  type EgressProxyHandle,
  type WritableSocket,
} from '../egressProxy';

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

/**
 * flushPending isoliert (#10): Bun's Socket.write schreibt bei Backpressure
 * WENIGER als uebergeben. Der ungeschriebene Rest wurde vorher bedingungslos
 * verworfen -> truncierter Request, Upstream haengt bis Timeout.
 */
describe('flushPending: Backpressure verwirft keine Bytes', () => {
  function fakeState(pending: string) {
    return {
      buf: Buffer.alloc(0),
      upstream: null,
      established: false,
      einzelRequest: false,
      connecting: true,
      pending: Buffer.from(pending),
    };
  }

  test('schreibt alles, wenn der Socket alles annimmt', () => {
    const state = fakeState('hallo-welt');
    const geschrieben: Buffer[] = [];
    const sock: WritableSocket = {
      write: (d) => {
        geschrieben.push(Buffer.from(d));
        return d.length;
      },
    };
    flushPending(state, sock);
    expect(Buffer.concat(geschrieben).toString()).toBe('hallo-welt');
    expect(state.pending.length).toBe(0);
    expect(state.established).toBe(true);
    expect(state.connecting).toBe(false);
  });

  test('behaelt den Rest, wenn der Socket nur einen Teil annimmt', () => {
    const state = fakeState('0123456789');
    let ersterAufruf = true;
    const sock: WritableSocket = {
      write: (d) => {
        // Erster Aufruf: nur 4 Bytes. Danach alles.
        if (ersterAufruf) {
          ersterAufruf = false;
          return 4;
        }
        return d.length;
      },
    };
    flushPending(state, sock);
    // Ohne Fix waere pending hier leer und established true -> 6 Bytes verloren.
    // Mit Fix schreibt die while-Schleife im selben Aufruf den Rest (zweiter
    // write nimmt alles), also ist am Ende alles raus.
    expect(state.pending.length).toBe(0);
    expect(state.established).toBe(true);
  });

  test('bricht ab und BEHAELT den Rest, wenn der Socket nichts mehr annimmt (Backpressure)', () => {
    const state = fakeState('0123456789');
    let rest = 10;
    const sock: WritableSocket = {
      write: (_d) => {
        if (rest === 10) {
          rest = 6;
          return 4; // erste 4 Bytes
        }
        return 0; // Kernel-Puffer voll -> nichts mehr, drain macht spaeter weiter
      },
    };
    flushPending(state, sock);
    // Der ungeschriebene Rest bleibt erhalten (drain-Handler schreibt ihn),
    // established bleibt false, solange pending nicht leer ist.
    expect(state.pending.toString()).toBe('456789');
    expect(state.established).toBe(false);
  });
});

/**
 * #1a: Der pending-Puffer waechst waehrend einer haengenden Zielpruefung
 * unbegrenzt -> OOM-Hebel fuer die per Design nicht vertrauenswuerdige MicroVM.
 * Mit Obergrenze wird die Verbindung getrennt statt den Host-RSS zu treiben.
 */
describe('EgressProxy — pending-Obergrenze (#1a)', () => {
  let langsam: EgressProxyHandle;

  beforeAll(() => {
    langsam = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      // Zielpruefung haengt: der Upstream kommt nie, pending wuerde ohne Grenze
      // ewig wachsen.
      checkTarget: () => new Promise(() => {}),
      maxPendingBytes: 4096,
    });
  });

  afterAll(() => langsam.stop());

  test('trennt die Verbindung, wenn pending die Grenze ueberschreitet', async () => {
    const geschlossen = await new Promise<boolean>((resolve) => {
      let zu = false;
      Bun.connect({
        hostname: '127.0.0.1',
        port: langsam.port,
        socket: {
          open(s) {
            // Head, der eine haengende Zielpruefung ausloest.
            s.write('POST http://haengt.example/ HTTP/1.1\r\nHost: x\r\n\r\n');
            // Body verzoegert als eigene Segmente nachschieben, waehrend die
            // Zielpruefung haengt — deutlich mehr als die 4096-B-Grenze.
            let i = 0;
            const timer = setInterval(() => {
              i += 1;
              s.write('x'.repeat(2000));
              if (i >= 10) clearInterval(timer);
            }, 5);
          },
          data() {
            // Der Proxy antwortet ggf. mit Fehlerzeilen — hier nur konsumieren.
          },
          close() {
            zu = true;
            resolve(true);
          },
          error() {
            resolve(zu);
          },
        },
      }).catch(() => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
    expect(geschlossen).toBe(true);
  });
});

/**
 * #11: absolute-form (plain HTTP ueber Proxy) ist KEIN Tunnel — jeder Request
 * braucht eigenes Umschreiben (Proxy-Header strippen, origin-form). Der Code
 * behandelte die Verbindung nach dem ersten Request aber wie einen Tunnel:
 * weitere Bytes gingen roh an den Upstream. Ein keep-alive-Client (undici mit
 * http_proxy, Default) schickt seinen ZWEITEN Request weiter in absolute-form
 * MIT Proxy-Authorization -> das VM-Token landet im Klartext beim Origin.
 */
describe('EgressProxy — absolute-form leakt das Token nicht auf keep-alive (#11)', () => {
  let sieht: string[];
  let origin: ReturnType<typeof Bun.serve>;
  let p: EgressProxyHandle;

  beforeAll(() => {
    sieht = [];
    origin = Bun.serve({
      port: 0,
      fetch: (req) => {
        // Was der Origin an Headern/Ziel sieht — hier darf NIE ein Proxy-Token auftauchen.
        sieht.push(
          `${req.method} ${new URL(req.url).pathname} auth=${req.headers.get('proxy-authorization') ?? 'keins'}`,
        );
        return new Response('ok');
      },
    });
    p = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      checkTarget: async (host) => ({ ok: true, address: host }),
    });
  });

  afterAll(() => {
    origin.stop(true);
    p.stop();
  });

  test('ein zweiter absolute-form-Request auf derselben Verbindung leakt kein Token', async () => {
    const auth = Buffer.from('mv:geheim').toString('base64');
    const req = (pfad: string) =>
      `GET http://127.0.0.1:${origin.port}${pfad} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${origin.port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`;

    await new Promise<void>((resolve) => {
      const s = Bun.connect({
        hostname: '127.0.0.1',
        port: p.port,
        socket: {
          open(sock) {
            sock.write(req('/erste'));
            // Zweiten Request verzoegert auf DERSELBEN Verbindung nachschieben.
            setTimeout(() => sock.write(req('/zweite')), 60);
          },
          data() {
            // Antworten hier nur konsumieren.
          },
          close() {
            resolve();
          },
          error() {
            resolve();
          },
        },
      });
      void s;
      setTimeout(() => resolve(), 2000);
    });

    // Der Origin darf den zweiten Request niemals mit anhaengendem Proxy-Token
    // gesehen haben. (Der erste ist korrekt umgeschrieben, ohne Token.)
    expect(sieht.every((z) => z.includes('auth=keins'))).toBe(true);
  });
});
