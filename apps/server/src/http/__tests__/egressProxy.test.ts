import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connect as netConnect } from 'node:net';
import {
  startEgressProxy,
  flushPending,
  macheTerminal,
  schreibeMitBackpressure,
  type EgressProxyHandle,
  type TerminalZustand,
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

/**
 * absolute-form als EIN atomarer Request: der Request wird per Content-Length
 * vollstaendig gepuffert und erst nach positiver Zielpruefung in einem Rutsch
 * geschrieben. Alles darueber hinaus ist ein zweiter Request und beendet die
 * Verbindung — er darf NIE (auch nicht roh aus dem pending-Puffer) beim Origin
 * ankommen, denn er truege `Proxy-Authorization: Basic base64(mv:<token>)`.
 */
/** Roher TCP-Origin, der ALLE gesehenen Bytes mitschneidet (Token-Waechter). */
function starteRecorderOrigin(): {
  port: number;
  gesehen: () => string;
  stop: () => void;
} {
  let mitschnitt = '';
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(s, chunk) {
        mitschnitt += new TextDecoder().decode(chunk);
        // Minimal antworten, sobald ein Kopf vollstaendig ist — NICHT
        // schliessen, damit auch spaeter eintreffende Bytes im Mitschnitt
        // landen.
        if (mitschnitt.includes('\r\n\r\n')) {
          s.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
        }
      },
    },
  });
  return {
    port: server.port,
    gesehen: () => mitschnitt,
    stop: () => server.stop(true),
  };
}

describe('EgressProxy — absolute-form als EIN atomarer Request', () => {
  /**
   * #1 (Sicherheit): Ein ZWEITER absolute-form-Request, der WAEHREND der
   * asynchronen Zielpruefung eintrifft, landete in state.pending und wurde von
   * flushPending RAW an den Upstream geschrieben — mitsamt Proxy-Authorization.
   * Jetzt gilt: Bytes ueber den einen Request hinaus beenden die Verbindung,
   * BEVOR irgendetwas an den Origin geht.
   */
  test('zweiter Request während der Zielprüfung erreicht den Origin nie (#1)', async () => {
    const origin = starteRecorderOrigin();
    const langsam = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      // Verzoegerte Pruefung oeffnet das Zeitfenster deterministisch.
      checkTarget: async (host) => {
        await Bun.sleep(50);
        return { ok: true, address: host };
      },
    });
    const auth = Buffer.from(`mv:${TOKEN}`).toString('base64');
    const req = (pfad: string): string =>
      `GET http://127.0.0.1:${origin.port}${pfad} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${origin.port}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`;

    try {
      await new Promise<void>((resolve) => {
        void Bun.connect({
          hostname: '127.0.0.1',
          port: langsam.port,
          socket: {
            open(s) {
              s.write(req('/erste'));
              // Der zweite Request trifft ein, waehrend die Pruefung des
              // ersten noch laeuft (15 ms < 50 ms).
              setTimeout(() => s.write(req('/zweite')), 15);
            },
            data() {
              // Antworten nur konsumieren.
            },
            close() {
              resolve();
            },
            error() {
              resolve();
            },
          },
        }).catch(() => resolve());
        setTimeout(() => resolve(), 500);
      });
      // Kernaussage: das Token (bzw. der Proxy-Auth-Header) taucht in dem, was
      // der Origin je gesehen hat, NIRGENDS auf — auch nicht als Rohbytes aus
      // dem pending-Puffer.
      expect(origin.gesehen().toLowerCase()).not.toContain('proxy-authorization');
      expect(origin.gesehen()).not.toContain(auth);
    } finally {
      origin.stop();
      langsam.stop();
    }
  });

  /**
   * #3: Ein mehrsegmentiger POST-Body (Content-Length > erstes TCP-Segment)
   * wurde nach etablierter Upstream-Verbindung vom einzelRequest-Schutz
   * abgeschnitten — der Origin bekam weniger Bytes als angekuendigt und hing.
   * Jetzt wird der Body ueber Segmentgrenzen hinweg bis zur Content-Length
   * gepuffert und komplett ausgeliefert.
   */
  test('mehrsegmentiger POST-Body wird vollständig ausgeliefert (#3)', async () => {
    const echo = Bun.serve({
      port: 0,
      fetch: async (req) => new Response(`gelesen:${await req.text()}`),
    });
    // Sofortige Zielpruefung: der Upstream steht, BEVOR die Body-Segmente
    // eintreffen — genau die Konstellation, in der der alte Schutz abschnitt.
    const schnell = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      checkTarget: async (host) => ({ ok: true, address: host }),
    });
    const teil1 = 'erste-haelfte-';
    const teil2 = 'zweite';
    const kopf =
      `POST http://127.0.0.1:${echo.port}/ HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${echo.port}\r\n` +
      `Content-Length: ${teil1.length + teil2.length}\r\n\r\n`;

    try {
      const antwort = await new Promise<string>((resolve, reject) => {
        let puffer = '';
        Bun.connect({
          hostname: '127.0.0.1',
          port: schnell.port,
          socket: {
            open(s) {
              s.write(kopf);
              setTimeout(() => s.write(teil1), 20);
              setTimeout(() => s.write(teil2), 40);
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
      expect(antwort).toContain('gelesen:erste-haelfte-zweite');
    } finally {
      echo.stop(true);
      schnell.stop();
    }
  });

  /**
   * #11: Nach `refuse` (Ziel abgelehnt) fielen noch eintreffende Restbytes in
   * den Head-Parsing-Zweig und starteten einen NEUEN checkTarget/verifyToken-
   * Zyklus auf einer Verbindung, die zugemacht werden sollte. Jetzt werden sie
   * verworfen. (Der Client haelt seine Schreibseite per allowHalfOpen offen —
   * genau das kann der untrusted Agent in der VM auch.)
   */
  test('Restbytes nach refuse starten keinen neuen Prüf-Zyklus (#11)', async () => {
    let aufrufe = 0;
    const verbot = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      checkTarget: async () => {
        aufrufe += 1;
        await Bun.sleep(5);
        return { ok: false, reason: 'test-verboten' };
      },
    });
    const auth = Buffer.from(`mv:${TOKEN}`).toString('base64');
    const req = (host: string): string =>
      `GET http://${host}/ HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`;

    let zweiterGesendet = false;
    try {
      await new Promise<void>((resolve) => {
        const client = netConnect({
          host: '127.0.0.1',
          port: verbot.port,
          allowHalfOpen: true,
        });
        let puffer = '';
        client.on('connect', () => client.write(req('verboten.example')));
        client.on('data', (chunk) => {
          puffer += chunk.toString();
          if (!zweiterGesendet && puffer.includes('403')) {
            zweiterGesendet = true;
            // Die 403 ist da, refuse ist gelaufen — jetzt kommen Restbytes.
            client.write(req('auch-verboten.example'));
            setTimeout(() => {
              client.destroy();
              resolve();
            }, 80);
          }
        });
        client.on('error', () => resolve());
        setTimeout(() => {
          client.destroy();
          resolve();
        }, 2000);
      });
      expect(zweiterGesendet).toBe(true);
      expect(aufrufe).toBe(1);
    } finally {
      verbot.stop();
    }
  });

  /**
   * Chunked Transfer-Encoding im Request-Body ist ueber diesen Proxy exotisch
   * und ohne Content-Length nicht sicher zu framen (Request-Grenze!). Er wird
   * sauber abgelehnt statt falsch behandelt.
   */
  test('chunked Transfer-Encoding im Request wird mit 411 abgelehnt', async () => {
    const origin = starteRecorderOrigin();
    const schnell = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      checkTarget: async (host) => ({ ok: true, address: host }),
    });
    const auth = Buffer.from(`mv:${TOKEN}`).toString('base64');
    try {
      const out = await new Promise<string>((resolve) => {
        let puffer = '';
        void Bun.connect({
          hostname: '127.0.0.1',
          port: schnell.port,
          socket: {
            open(s) {
              s.write(
                `POST http://127.0.0.1:${origin.port}/ HTTP/1.1\r\n` +
                  `Host: 127.0.0.1:${origin.port}\r\n` +
                  `Proxy-Authorization: Basic ${auth}\r\n` +
                  'Transfer-Encoding: chunked\r\n\r\n' +
                  '5\r\nhallo\r\n0\r\n\r\n',
              );
            },
            data(_s, chunk) {
              puffer += new TextDecoder().decode(chunk);
            },
            close() {
              resolve(puffer);
            },
            error() {
              resolve(puffer);
            },
          },
        }).catch(() => resolve(puffer));
        setTimeout(() => resolve(puffer), 2000);
      });
      expect(out).toContain('411');
      // Nichts davon darf den Origin erreicht haben.
      expect(origin.gesehen()).toBe('');
    } finally {
      origin.stop();
      schnell.stop();
    }
  });
});

/**
 * #4: Bun's Socket.write macht bei vollem Kernel-Puffer TEILSCHREIBUNGEN
 * (Rueckgabewert = geschriebene Bytes). Der established-Fastpath des Tunnels
 * ignorierte den Rueckgabewert in BEIDEN Richtungen — der ungeschriebene Rest
 * ging still verloren (truncierter/korrupter TLS-Stream).
 */
describe('schreibeMitBackpressure (#4): Teilschreibungen ohne Byte-Verlust', () => {
  test('nimmt der Socket alles an, bleibt kein Rest', () => {
    const angenommen: Buffer[] = [];
    const sock: WritableSocket = {
      write: (d) => {
        angenommen.push(Buffer.from(d));
        return d.length;
      },
    };
    const rest = schreibeMitBackpressure(sock, Buffer.from('hallo-tunnel'));
    expect(rest.length).toBe(0);
    expect(Buffer.concat(angenommen).toString()).toBe('hallo-tunnel');
  });

  test('bei Teilannahme bleibt der Rest erhalten und drain schreibt ihn in Reihenfolge weiter', () => {
    const angenommen: Buffer[] = [];
    let budget = 4;
    const sock: WritableSocket = {
      write: (d) => {
        const n = Math.min(budget, d.length);
        if (n > 0) angenommen.push(Buffer.from(d.subarray(0, n)));
        budget -= n;
        return n;
      },
    };
    let rest = schreibeMitBackpressure(sock, Buffer.from('0123456789'));
    // Nur 4 Bytes passten — der Rest darf NICHT verworfen sein.
    expect(rest.toString()).toBe('456789');
    // drain: der Kernel-Puffer hat wieder Platz, der Rest geht in Reihenfolge raus.
    budget = 100;
    rest = schreibeMitBackpressure(sock, rest);
    expect(rest.length).toBe(0);
    expect(Buffer.concat(angenommen).toString()).toBe('0123456789');
  });
});

/**
 * #4 integriert: Ein grosser Transfer durch den CONNECT-Tunnel muss in BEIDEN
 * Richtungen vollstaendig und unverfaelscht ankommen. Die 4-MiB-Bloecke
 * ueberfahren den Loopback-Kernel-Puffer deutlich — ohne Backpressure-
 * Behandlung gehen Bytes verloren.
 */
describe('EgressProxy — CONNECT-Tunnel: großer Transfer ohne Byte-Verlust (#4)', () => {
  const GROESSE = 4 * 1024 * 1024;

  function muster(): Buffer {
    const b = Buffer.alloc(GROESSE);
    for (let i = 0; i < GROESSE; i += 1) b[i] = i % 251;
    return b;
  }

  /** Schreibt mit Teilschreibungs-Behandlung (Test-eigene, unabhaengige Logik). */
  function schreibeRest(s: { write(d: Uint8Array): number }, puffer: Buffer): Buffer {
    let rest = puffer;
    while (rest.length > 0) {
      const n = s.write(rest);
      if (typeof n !== 'number' || n <= 0) break;
      rest = Buffer.from(rest.subarray(n));
    }
    return rest;
  }

  test('4 MiB hin und 4 MiB zurück kommen vollständig an', async () => {
    const daten = muster();
    // Senke: nimmt GROESSE Bytes entgegen, schickt danach GROESSE Bytes zurueck.
    const empfangenBeimSink: Buffer[] = [];
    let sinkBytes = 0;
    let sinkOutbox: Buffer = Buffer.alloc(0);
    let sinkFertig = false;
    const sink = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(s, chunk) {
          empfangenBeimSink.push(Buffer.from(chunk));
          sinkBytes += chunk.length;
          if (sinkBytes === GROESSE) {
            sinkOutbox = schreibeRest(s, daten);
            sinkFertig = true;
            if (sinkOutbox.length === 0) s.end();
          }
        },
        drain(s) {
          if (sinkOutbox.length > 0) sinkOutbox = schreibeRest(s, sinkOutbox);
          if (sinkFertig && sinkOutbox.length === 0) s.end();
        },
      },
    });
    const p = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      checkTarget: async (host) => ({ ok: true, address: host }),
    });
    const auth = Buffer.from(`mv:${TOKEN}`).toString('base64');

    try {
      const zurueck = await new Promise<Buffer>((resolve, reject) => {
        const antwortTeile: Buffer[] = [];
        let kopfText = '';
        let kopfFertig = false;
        let outbox: Buffer = Buffer.alloc(0);
        Bun.connect({
          hostname: '127.0.0.1',
          port: p.port,
          socket: {
            open(s) {
              s.write(
                `CONNECT 127.0.0.1:${sink.port} HTTP/1.1\r\n` +
                  `Host: 127.0.0.1:${sink.port}\r\n` +
                  `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
              );
            },
            data(s, chunk) {
              if (!kopfFertig) {
                kopfText += new TextDecoder().decode(chunk);
                const ende = kopfText.indexOf('\r\n\r\n');
                if (ende === -1) return;
                if (!kopfText.includes('200')) {
                  reject(new Error(`CONNECT fehlgeschlagen: ${kopfText}`));
                  return;
                }
                kopfFertig = true;
                // Tunnel steht: die 4 MiB rausschieben (mit Teilschreibungen).
                outbox = schreibeRest(s, daten);
                return;
              }
              antwortTeile.push(Buffer.from(chunk));
            },
            drain(s) {
              if (outbox.length > 0) outbox = schreibeRest(s, outbox);
            },
            close() {
              resolve(Buffer.concat(antwortTeile));
            },
            error(_s, err) {
              reject(err);
            },
          },
        }).catch(reject);
        setTimeout(() => resolve(Buffer.concat(antwortTeile)), 8000);
      });

      const hin = Buffer.concat(empfangenBeimSink);
      expect(hin.length).toBe(GROESSE);
      expect(Buffer.compare(hin, daten)).toBe(0);
      expect(zurueck.length).toBe(GROESSE);
      expect(Buffer.compare(zurueck, daten)).toBe(0);
    } finally {
      sink.stop(true);
      p.stop();
    }
  }, 10_000);
});

/**
 * Defekt 4 + 5 auf Zustandsebene: `socket.end()` beendet nur die Schreibseite —
 * je nach Bun-Version liefert die Leseseite danach weiter data-Events, und der
 * asynchrone Upstream-open-Callback kann im Fenster vor dem Client-close
 * feuern. Jeder Abbruchpfad muss die Verbindung deshalb VOLLSTAENDIG terminal
 * machen: Phase 'zu' (Defekt 4a: buf wuchs sonst unbegrenzt weiter; 4b: ein
 * nachgereichter Terminator wurde doch noch geparst und geproxied) UND
 * einzel/clientZu raeumen (Defekt 5: der 'einzel'-Ueberlauf-Pfad verspricht,
 * einen noch nicht gesendeten Erst-Request nicht mehr zu senden — ohne
 * clientZu/einzel-Reset sendete open() → sendeEinzel() ihn im Fenster doch).
 *
 * (Auf Bun 1.3.14/macOS schliesst end() den Socket sofort vollstaendig, die
 * Fenster lassen sich ueber echte Sockets also nicht stellen — deshalb wird
 * die Aufraeumlogik hier als exportierte Naht direkt geprueft; die
 * Integrationstests weiter unten pinnen das Verhalten zusaetzlich Ende-zu-Ende.)
 */
describe('macheTerminal — Abbruch räumt den Verbindungszustand vollständig (Defekt 4+5)', () => {
  function offenerZustand(): TerminalZustand {
    return {
      phase: 'kopf',
      buf: Buffer.from(`CONNECT example.com:443 HTTP/1.1\r\nX-Fueller: ${'a'.repeat(40_000)}`),
      pending: Buffer.from('rest-fuer-upstream'),
      einzel: { kopf: Buffer.from('POST / HTTP/1.1'), bodySoll: 5, body: Buffer.from('hallo') },
      connecting: true,
      clientZu: false,
    };
  }

  test('Defekt 4: Phase wird terminal und buf/pending werden geleert', () => {
    const state = offenerZustand();
    macheTerminal(state);
    // Phase 'zu': der data-Handler returnt als Erstes, nichts wird mehr
    // konkateniert oder geparst — buf kann nicht weiter wachsen.
    expect(state.phase).toBe('zu');
    expect(state.buf.length).toBe(0);
    expect(state.pending.length).toBe(0);
  });

  test('Defekt 5: einzel wird geräumt und clientZu gesetzt — open()/sendeEinzel senden nichts mehr', () => {
    const state = offenerZustand();
    macheTerminal(state);
    // Beide Guards des Fensters: open() prueft clientZu, sendeEinzel prueft
    // einzel === null — der gepufferte Erst-Request wird NIE mehr gesendet.
    expect(state.einzel).toBeNull();
    expect(state.clientZu).toBe(true);
    expect(state.connecting).toBe(false);
  });
});

/**
 * Defekt 4: Der Header-Bomben-Pfad (Kopf > 32 KiB ohne Leerzeile) beendete nur
 * die SCHREIBSEITE (socket.end() = Half-Close) und liess die Phase auf 'kopf'.
 * Bun liefert nach end() weiter data-Events: (a) state.buf wuchs mit jedem
 * weiteren Segment UNBEGRENZT (die 8-MiB-Grenze gilt nur fuer pending/
 * antwortPending) — Speicherhebel der untrusted VM; (b) kam NACH der Grenze
 * doch noch ein Terminator samt gueltigem Kopf, wurde er normal geparst und
 * geproxied — funktionierender Einweg-Tunnel trotz "beendeter" Verbindung.
 * Jetzt ist der Pfad terminal (Phase 'zu', buf geleert): alles Weitere wird
 * verworfen, nichts wird mehr geparst oder weitergereicht.
 */
describe('EgressProxy — Header-Bombe ist terminal (Defekt 4)', () => {
  /** Gueltige Fueller-Kopfzeilen mit mindestens `mindestens` Bytes. */
  function fuellzeilen(mindestens: number): string {
    const zeile = `X-Fueller: ${'a'.repeat(1000)}\r\n`;
    let s = '';
    while (s.length <= mindestens) s += zeile;
    return s;
  }

  test('nach Überschreiten der Kopf-Grenze werden weitere Bytes verworfen (kein Prüf-Zyklus)', async () => {
    let aufrufe = 0;
    const p = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      checkTarget: async (host) => {
        aufrufe += 1;
        return { ok: true, address: host };
      },
    });
    try {
      const endeGesehen = await new Promise<boolean>((resolve) => {
        // allowHalfOpen: der Proxy beendet nur seine Schreibseite — die
        // Schreibseite des Clients bleibt offen, genau wie beim untrusted
        // Agenten in der VM.
        const client = netConnect({ host: '127.0.0.1', port: p.port, allowHalfOpen: true });
        client.on('connect', () => {
          // > 32 KiB gueltige Kopfzeilen OHNE abschliessende Leerzeile.
          client.write(`CONNECT example.com:443 HTTP/1.1\r\n${fuellzeilen(33_000)}`);
        });
        client.on('end', () => {
          // Der Proxy hat seine Schreibseite beendet (Grenze ueberschritten).
          // Jetzt weitere Chunks nachschieben und den Kopf mit der Leerzeile
          // "vervollstaendigen": wuerde state.buf weiter konkateniert, waere
          // der Kopf nun vollstaendig UND gueltig — und checkTarget feuerte.
          client.write(fuellzeilen(4000));
          client.write('\r\n');
          setTimeout(() => {
            client.destroy();
            resolve(true);
          }, 150);
        });
        client.on('error', () => resolve(false));
        setTimeout(() => {
          client.destroy();
          resolve(false);
        }, 3000);
      });
      expect(endeGesehen).toBe(true);
      // Kein Pruef-Zyklus: die Bytes nach der Grenze wurden verworfen statt in
      // state.buf gesammelt und geparst (Konkatenation passiert nur in Phase
      // 'kopf' — waere die Phase nicht terminal, haette der Terminator geparst).
      expect(aufrufe).toBe(0);
    } finally {
      p.stop();
    }
  });

  test('33 KiB Kopf + nachgereichter Terminator wird NICHT geproxied', async () => {
    const origin = starteRecorderOrigin();
    const p = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      checkTarget: async (host) => ({ ok: true, address: host }),
    });
    const auth = Buffer.from(`mv:${TOKEN}`).toString('base64');
    try {
      await new Promise<void>((resolve) => {
        const client = netConnect({ host: '127.0.0.1', port: p.port, allowHalfOpen: true });
        client.on('connect', () => {
          client.write(
            `GET http://127.0.0.1:${origin.port}/spaet HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${origin.port}\r\n` +
              `Proxy-Authorization: Basic ${auth}\r\n` +
              fuellzeilen(33_000),
          );
        });
        client.on('end', () => {
          // Nach dem Half-Close des Proxys den Kopf "abschliessen".
          client.write('\r\n');
          setTimeout(() => {
            client.destroy();
            resolve();
          }, 200);
        });
        client.on('error', () => resolve());
        setTimeout(() => {
          client.destroy();
          resolve();
        }, 3000);
      });
      // Der Origin darf NIE etwas gesehen haben — kein Einweg-Tunnel trotz
      // "beendeter" Verbindung.
      expect(origin.gesehen()).toBe('');
    } finally {
      origin.stop();
      p.stop();
    }
  });
});

/**
 * Defekt 5: `beendeBeide` (Ueberschuss-Bytes in Phase 'einzel') setzte weder
 * `clientZu` noch `einzel = null`. Trafen Ueberschuss-Bytes WAEHREND der
 * asynchronen Zielpruefung ein und feuerte der Upstream-open-Callback im
 * Fenster vor dem close des Client-Sockets, sendete open() → sendeEinzel()
 * den gepufferten Erst-Request (z. B. POST mit Seiteneffekten) DOCH noch an
 * den Origin — obwohl der Kommentar am Ueberlauf-Pfad das Gegenteil
 * verspricht. Jetzt raeumt beendeBeide auf wie refuse/connect-catch.
 */
describe('EgressProxy — beendeBeide unterdrückt den gepufferten Erst-Request (Defekt 5)', () => {
  test('Überschuss während der Zielprüfung → nach open geht NICHTS an den Origin', async () => {
    const origin = starteRecorderOrigin();
    // Zielpruefung haengt an einem Tor, das der Test selbst oeffnet — das
    // Fenster (beendeBeide VOR open-Callback) steht damit deterministisch.
    let freigeben: () => void = () => {};
    const tor = new Promise<void>((r) => {
      freigeben = r;
    });
    const p = startEgressProxy({
      port: 0,
      verifyToken: () => ({ sandbox: 'test' }),
      checkTarget: async (host) => {
        await tor;
        return { ok: true, address: host };
      },
    });
    const auth = Buffer.from(`mv:${TOKEN}`).toString('base64');
    const koerper = 'hallo';
    try {
      await new Promise<void>((resolve) => {
        // allowHalfOpen: das close des Client-Sockets beim Proxy bleibt aus,
        // solange der Client seine Schreibseite offen haelt — das Fenster,
        // in dem clientZu ohne den Fix noch false waere.
        const client = netConnect({ host: '127.0.0.1', port: p.port, allowHalfOpen: true });
        client.on('connect', () => {
          // Vollstaendiger POST (Body komplett gepuffert) — sendewuerdig,
          // sobald der Upstream offen ist.
          client.write(
            `POST http://127.0.0.1:${origin.port}/seiteneffekt HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${origin.port}\r\n` +
              `Proxy-Authorization: Basic ${auth}\r\n` +
              `Content-Length: ${koerper.length}\r\n\r\n` +
              koerper,
          );
          // Ueberschuss-Byte waehrend die Zielpruefung noch am Tor haengt:
          // beendeBeide feuert — der Erst-Request darf NICHT mehr gesendet
          // werden.
          setTimeout(() => client.write('X'), 40);
          // Erst DANACH das Tor oeffnen: connect + open-Callback feuern im
          // Fenster vor dem Client-close.
          setTimeout(() => freigeben(), 80);
          setTimeout(() => {
            client.destroy();
            resolve();
          }, 400);
        });
        client.on('error', () => resolve());
        setTimeout(() => {
          client.destroy();
          resolve();
        }, 3000);
      });
      // Kernaussage: der gepufferte Erst-Request (samt Body und ohnehin ohne
      // Token) erreicht den Origin NIE — die Trennung gilt.
      expect(origin.gesehen()).toBe('');
    } finally {
      origin.stop();
      p.stop();
    }
  });
});
