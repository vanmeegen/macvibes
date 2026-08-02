/**
 * Egress-Proxy für die MicroVMs (CONNECT-Tunnel + absolute-form HTTP).
 *
 * WARUM: microsandbox' --net-rule-Engine blockt JEGLICHEN Public-Egress,
 * sobald Regeln gesetzt sind (selbst allow@0.0.0.0/0 — nur der Host-Gateway
 * bleibt erreichbar); ohne Regeln ist umgekehrt der Gateway dicht. Der Agent
 * (claude-Startup, bun install) braucht aber beides. Lösung: die VM behält die
 * restriktiven Regeln (nur Gateway) und routet allen übrigen Traffic per
 * HTTP(S)_PROXY über diesen Proxy auf dem Host — ein einziger, authentisierter
 * Egress-Punkt. DNS der Ziele löst der HOST auf (im Gast ist DNS ohnehin tot).
 *
 * Zwei strikt getrennte Betriebsarten (state.phase):
 *
 * - CONNECT ('tunnel'): opake Bytes, echter bidirektionaler Stream. Beide
 *   Richtungen behandeln Teilschreibungen (Bun's Socket.write schreibt bei
 *   vollem Kernel-Puffer WENIGER als übergeben und meldet die Zahl): der
 *   ungeschriebene Rest bleibt in einem Richtungs-Puffer, `drain` schreibt ihn
 *   in Reihenfolge weiter, und die Quell-Seite wird per pause()/resume()
 *   angehalten, solange die Ziel-Seite nicht aufnimmt — so bleibt der Puffer
 *   klein, statt bis zur Obergrenze zu wachsen.
 *
 * - absolute-form ('einzel'): KEIN Tunnel — genau EIN Request pro Verbindung,
 *   atomar. Kopf-Rest + Body (Länge per Content-Length, 0 ohne Header) werden
 *   vollständig gepuffert; erst wenn die Zielprüfung positiv ist UND der Body
 *   komplett ist, geht der umgeschriebene Kopf (origin-form, Proxy-Header
 *   gestrippt, Connection: close erzwungen) + Body in einem Rutsch an den
 *   Upstream. Jedes Byte über den einen Request hinaus ist ein zweiter Request
 *   und beendet die Verbindung — roh weitergereicht käme er in absolute-form
 *   mitsamt `Proxy-Authorization: Basic base64(mv:<token>)` beim Origin an und
 *   leakte das VM-Token. Chunked Transfer-Encoding im Request-Body wird mit
 *   411 abgelehnt: ohne Content-Length gibt es keine sichere Request-Grenze.
 */

import type { Socket, TCPSocketListener } from 'bun';
import { lookup } from 'node:dns/promises';
import { checkTarget, defaultEgressPolicy, type EgressPolicy } from './egressPolicy';

/** Ergebnis der Zielprüfung: bei ok die Adresse, zu der verbunden wird. */
export type TargetDecision = { ok: true; address: string } | { ok: false; reason: string };

/** Prüft ein Ziel und liefert die zu verwendende IP (F3). */
export type TargetChecker = (host: string, port: number) => Promise<TargetDecision>;

export interface EgressProxyOptions {
  port: number;
  /** Prüft das Basic-Auth-Passwort (VM-Token, F12); null = ungültig. */
  verifyToken: (token: string | null) => { sandbox: string } | null;
  hostname?: string;
  /**
   * Zielprüfung — Default ist die echte Policy (DNS auf dem Host + Sperrliste).
   * Als DI-Naht überschreibbar, damit Tests die Tunnel-Mechanik gegen einen
   * lokalen Fake-Upstream prüfen können, ohne die Policy aufzuweichen.
   */
  checkTarget?: TargetChecker;
  /** Obergrenze der Puffer pro Verbindung (Default 8 MiB). Test-Naht. */
  maxPendingBytes?: number;
}

/**
 * Löst den Namen auf dem Host auf, prüft ALLE Adressen gegen die Policy und
 * gibt die geprüfte IP zurück. Verbunden wird anschließend genau zu dieser
 * Adresse — nicht erneut zum Namen, sonst bliebe ein DNS-Rebinding-Fenster.
 */
export function createTargetChecker(policy: EgressPolicy = defaultEgressPolicy()): TargetChecker {
  return async (host, port) => {
    let addresses: string[];
    try {
      addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    } catch {
      addresses = [];
    }
    const verdict = checkTarget(host, port, addresses, policy);
    if (!verdict.ok) return verdict;
    return { ok: true, address: addresses[0] as string };
  };
}

/**
 * Strikte Zerlegung des Requestkopfes. Sobald es eine Zielpolicy gibt, wird
 * die Nachlässigkeit hier sicherheitsrelevant: mit einem nackten \n ließe
 * sich eine zweite Request-Line einschmuggeln, die am Policy-Check vorbeiläuft.
 */
export function parseProxyHead(
  head: string,
): { requestLine: string; headerLines: string[] } | null {
  if (head.includes('\n') || head.includes('\r')) {
    // Nach dem Split an \r\n darf kein einzelnes \r oder \n mehr vorkommen.
    const lines = head.split('\r\n');
    if (lines.some((line) => line.includes('\n') || line.includes('\r'))) return null;
  }
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const parts = requestLine.split(' ');
  if (parts.length !== 3) return null;
  const [method = '', , version = ''] = parts;
  if (!/^[A-Za-z]+$/.test(method)) return null;
  if (!/^HTTP\/1\.[01]$/.test(version)) return null;

  const headerLines = lines.slice(1);
  for (const line of headerLines) {
    if (line === '') continue;
    // Keine Obs-Fold-Fortsetzungszeilen und nur gültige Header-Namen.
    if (/^[ \t]/.test(line)) return null;
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, colon))) return null;
  }
  return { requestLine, headerLines };
}

/**
 * Liest die Content-Length aus den Kopfzeilen. 0, wenn der Header fehlt (z. B.
 * GET); null bei ungültigem oder widersprüchlichem Wert — das ist Request-
 * Smuggling-Terrain und wird abgelehnt.
 */
export function contentLengthAus(headerLines: string[]): number | null {
  const werte = headerLines
    .filter((line) => line.toLowerCase().startsWith('content-length:'))
    .map((line) => line.slice('content-length:'.length).trim());
  if (werte.length === 0) return 0;
  const erster = werte[0] as string;
  if (!/^\d{1,15}$/.test(erster)) return null;
  if (werte.some((wert) => wert !== erster)) return null;
  return Number(erster);
}

export interface EgressProxyHandle {
  port: number;
  stop: () => void;
}

/**
 * Obergrenze für die Richtungs-Puffer einer Verbindung (H5-analog). Ohne
 * Grenze wären sie ein Speicher-Hebel für die per Design nicht
 * vertrauenswürdige MicroVM (Dauerfeuer gegen einen langsam auflösenden oder
 * langsam lesenden Gegenüber → Host-RSS bis zum OOM). Durch pause()/resume()
 * bleiben die Puffer im Normalfall weit darunter; die Grenze ist der harte
 * Notanker. 8 MiB deckt zugleich legitime große absolute-form-Bodies.
 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** Der Ausschnitt eines Bun-Sockets, den die Flush-Helfer brauchen (Test-Naht). */
export interface WritableSocket {
  write(data: Uint8Array): number;
}

/**
 * Schreibt so viel von `puffer` an den Socket, wie dieser annimmt, und gibt
 * den ungeschriebenen Rest zurück.
 *
 * Bun's `Socket.write` schreibt bei vollem Kernel-Puffer WENIGER als übergeben
 * und meldet die tatsächlich geschriebene Zahl (-1 bei geschlossenem Socket) —
 * der Rest muss aufgehoben und beim `drain`-Event erneut geschrieben werden.
 * Ihn zu verwerfen, trunciert den Stream: der Gegenüber bekommt weniger Bytes
 * als angekündigt und hängt bis zum Timeout bzw. sieht korrupte Daten.
 */
export function schreibeMitBackpressure(sock: WritableSocket, puffer: Buffer): Buffer {
  let rest = puffer;
  while (rest.length > 0) {
    const geschrieben = sock.write(rest);
    // <= 0: Socket zu oder komplett gepuffert — der drain-Handler macht weiter.
    if (typeof geschrieben !== 'number' || geschrieben <= 0) break;
    rest = geschrieben >= rest.length ? Buffer.alloc(0) : Buffer.from(rest.subarray(geschrieben));
  }
  return rest;
}

/** Der Teil des Verbindungszustands, den `flushPending` fortschreibt (Test-Naht). */
export interface FlushZustand {
  /** client→upstream: noch nicht (vollständig) geschriebene Bytes. */
  pending: Buffer;
  /** Upstream verbunden UND `pending` vollständig geflusht. */
  established: boolean;
  /** Zielprüfung (DNS + Policy) läuft — sie ist asynchron. */
  connecting: boolean;
}

/**
 * Schreibt so viel von `pending` an den Upstream, wie der Socket annimmt, und
 * behält den ungeschriebenen Rest (s. schreibeMitBackpressure).
 *
 * `established` wird erst gesetzt, wenn `pending` LEER ist. Solange noch ein
 * Rest aussteht, müssen neue Bytes weiter über `pending` laufen — schriebe der
 * data-Handler sie schon direkt an den Upstream, überholten sie den Rest und
 * die Reihenfolge bräche.
 */
export function flushPending(state: FlushZustand, up: WritableSocket): void {
  state.pending = schreibeMitBackpressure(up, state.pending);
  state.connecting = false;
  if (state.pending.length === 0) state.established = true;
}

/**
 * Der EINE absolute-form-Request einer Verbindung. Es gibt bewusst keinen
 * zweiten: die Request-Grenze ist über Content-Length exakt bekannt, alles
 * darüber hinaus beendet die Verbindung (Token-Leak-Schutz, s. Moduldoku).
 */
interface EinzelRequest {
  /** Bereits umgeschriebener Kopf (origin-form, Proxy-Header gestrippt). */
  kopf: Buffer;
  /** Body-Länge laut Content-Length (0 ohne Header, z. B. GET). */
  bodySoll: number;
  /** Bislang gepufferter Body — wächst nie über `bodySoll`. */
  body: Buffer;
  /** Kopf + Body sind an den Upstream übergeben (via pending/flushPending). */
  gesendet: boolean;
}

/**
 * Lebensphase einer Client-Verbindung. 'zu' ist terminal: die Verbindung ist
 * abgelehnt oder erledigt; bis der Close greift, noch eintreffende Bytes
 * werden verworfen — sie dürfen insbesondere NICHT erneut als Request-Kopf
 * geparst werden.
 */
export type Phase = 'kopf' | 'tunnel' | 'einzel' | 'zu';

/** Der Ausschnitt des Verbindungszustands, den `macheTerminal` räumt (Test-Naht). */
export interface TerminalZustand {
  phase: Phase;
  /** Sammelpuffer für den Request-Kopf (nur Phase 'kopf'). */
  buf: Buffer;
  /** client→upstream: noch nicht (vollständig) geschriebene Bytes. */
  pending: Buffer;
  /** Nur Phase 'einzel': der eine atomare absolute-form-Request. */
  einzel: object | null;
  connecting: boolean;
  clientZu: boolean;
}

/**
 * Versetzt eine Verbindung terminal in Phase 'zu' und räumt ALLES, was in
 * Richtung Upstream noch wirken könnte. JEDER Abbruchpfad muss hierüber laufen:
 *
 * - Phase 'zu' + leerer `buf` (Defekt 4): `socket.end()` beendet nur die
 *   Schreibseite — je nach Bun-Version liefert die Leseseite danach weiter
 *   data-Events. Bliebe die Phase 'kopf', wüchse `buf` unbegrenzt weiter
 *   (Speicherhebel der untrusted VM), und ein nachgereichter Terminator würde
 *   doch noch geparst und geproxied (Einweg-Tunnel trotz "beendeter"
 *   Verbindung).
 * - `einzel = null` + `clientZu = true` (Defekt 5): feuert der asynchrone
 *   Upstream-open-Callback im Fenster vor dem close des Client-Sockets, darf
 *   `open() → sendeEinzel()` den gepufferten Erst-Request (z. B. POST mit
 *   Seiteneffekten) NICHT mehr an den Origin senden — beide Guards greifen.
 * - `pending` leer + `connecting = false`: kein Flush schreibt mehr Restbytes.
 *
 * `antwortPending` (upstream→client) bleibt unberührt: eine schon empfangene
 * Antwort darf der Client-drain-Handler noch fertig ausliefern.
 */
export function macheTerminal(state: TerminalZustand): void {
  state.phase = 'zu';
  state.buf = Buffer.alloc(0);
  state.pending = Buffer.alloc(0);
  state.einzel = null;
  state.connecting = false;
  state.clientZu = true;
}

interface ConnState extends FlushZustand {
  /** Sammelpuffer für den Request-Kopf (nur Phase 'kopf'). */
  buf: Buffer;
  upstream: Socket | null;
  phase: Phase;
  /** upstream→client: bei Backpressure noch nicht geschriebene Antwort-Bytes. */
  antwortPending: Buffer;
  /** Nur Phase 'einzel': der eine atomare absolute-form-Request. */
  einzel: EinzelRequest | null;
  /** Der Client hat geschlossen — Upstream nach dem letzten Flush beenden. */
  clientZu: boolean;
  /** Der Upstream hat geschlossen — Client nach dem letzten Flush beenden. */
  upstreamZu: boolean;
}

export function startEgressProxy(options: EgressProxyOptions): EgressProxyHandle {
  /** Zerlegt "Basic base64(mv:<token>)" und gibt das Token zurück. */
  const tokenFromAuth = (header: string): string | null => {
    if (!header.toLowerCase().startsWith('basic ')) return null;
    try {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString();
      const sep = decoded.indexOf(':');
      return sep === -1 ? null : decoded.slice(sep + 1);
    } catch {
      return null;
    }
  };
  const checkTargetFn = options.checkTarget ?? createTargetChecker();
  const grenze = options.maxPendingBytes ?? MAX_PENDING_BYTES;

  /**
   * Beendet Client UND Upstream; alles Weitere wird verworfen (Phase 'zu').
   * macheTerminal räumt dabei auch `einzel`/`clientZu` (Defekt 5): sonst
   * sendete der Upstream-open-Callback im Fenster vor dem Client-close einen
   * noch nicht gesendeten Erst-Request doch noch an den Origin.
   */
  const beendeBeide = (client: Socket<ConnState>): void => {
    macheTerminal(client.data);
    client.data.upstream?.end();
    client.end();
  };

  /**
   * Schreibt Bytes Richtung Client — mit Teilschreibungs-Behandlung. Bleibt
   * ein Rest, wird der Upstream pausiert; der drain-Handler des Clients
   * schreibt weiter und resumed.
   */
  const anClient = (client: Socket<ConnState>, chunk: Uint8Array): void => {
    const state = client.data;
    if (state.antwortPending.length + chunk.length > grenze) {
      console.warn(`EgressProxy: Antwort-Puffer über ${grenze} B — Verbindung getrennt.`);
      beendeBeide(client);
      return;
    }
    state.antwortPending =
      state.antwortPending.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([state.antwortPending, chunk]);
    state.antwortPending = schreibeMitBackpressure(client, state.antwortPending);
    if (state.antwortPending.length > 0) state.upstream?.pause();
  };

  /**
   * Schickt den atomaren absolute-form-Request los, sobald BEIDE Bedingungen
   * erfüllt sind: Zielprüfung positiv (Upstream offen) UND Body vollständig
   * gepuffert. Vorher geht kein einziges Byte an den Origin.
   */
  const sendeEinzel = (client: Socket<ConnState>): void => {
    const state = client.data;
    const einzel = state.einzel;
    const up = state.upstream;
    if (einzel === null || up === null || einzel.gesendet) return;
    if (einzel.body.length < einzel.bodySoll) return;
    einzel.gesendet = true;
    state.pending = Buffer.concat([einzel.kopf, einzel.body]);
    flushPending(state, up);
  };

  const refuse = (client: Socket<ConnState>, reason: string): void => {
    console.warn(`EgressProxy: Ziel abgelehnt — ${reason}`);
    // Terminal: Puffer freigeben und alles Weitere verwerfen. Ohne die
    // Phasen-Umschaltung fielen Restbytes, die zwischen refuse und dem
    // tatsächlichen Close noch eintreffen, erneut in das Kopf-Parsing.
    macheTerminal(client.data);
    client.write(
      `HTTP/1.1 403 Forbidden\r\nConnection: close\r\ncontent-length: 0\r\nx-macvibes-reason: ${reason.replace(/[\r\n]/g, ' ')}\r\n\r\n`,
    );
    client.end();
  };

  /** Prüft das Ziel und verbindet nur bei positivem Bescheid (F3). */
  const connectChecked = (
    client: Socket<ConnState>,
    host: string,
    port: number,
    onOpen: (upstream: Socket) => void,
  ): void => {
    void checkTargetFn(host, port).then((decision) => {
      if (!decision.ok) {
        refuse(client, decision.reason);
        return;
      }
      connectUpstream(client, decision.address, port, onOpen);
    });
  };

  const connectUpstream = (
    client: Socket<ConnState>,
    host: string,
    port: number,
    onOpen: (upstream: Socket) => void,
  ): void => {
    const state = client.data;
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(up) {
          if (state.clientZu) {
            // Der Client ist während der Zielprüfung schon weg.
            up.end();
            return;
          }
          state.upstream = up;
          onOpen(up);
        },
        drain(up) {
          // Kernel-Puffer hat wieder Platz — ausstehende pending-Bytes weiter
          // an den Upstream schreiben (Backpressure, s. flushPending).
          if (state.pending.length > 0) flushPending(state, up);
          if (state.pending.length === 0) {
            if (state.clientZu) up.end();
            else client.resume();
          }
        },
        data(_up, chunk) {
          anClient(client, chunk);
        },
        close() {
          state.upstreamZu = true;
          // Der Upstream ist weg → die Verbindung ist terminal: ohne Phase 'zu'
          // sammelte der data-Handler weiter Bytes für einen toten Upstream
          // (bzw. parste sie in Phase 'kopf'). antwortPending bleibt: einen
          // Antwort-Rest erst ausliefern (Client-drain), dann schließen.
          macheTerminal(state);
          if (state.antwortPending.length === 0) client.end();
        },
        error(_up, error) {
          console.error(`EgressProxy: Upstream-Fehler ${host}:${port}:`, error.message);
          state.upstreamZu = true;
          macheTerminal(state);
          client.end();
        },
      },
    }).catch((error: unknown) => {
      console.error(`EgressProxy: Connect zu ${host}:${port} fehlgeschlagen:`, error);
      // Kein Upstream, also läuft kein Flush mehr — terminal, Rest verwerfen.
      macheTerminal(state);
      client.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      client.end();
    });
  };

  const listener: TCPSocketListener<ConnState> = Bun.listen<ConnState>({
    hostname: options.hostname ?? '0.0.0.0',
    port: options.port,
    socket: {
      open(socket) {
        socket.data = {
          buf: Buffer.alloc(0),
          upstream: null,
          phase: 'kopf',
          established: false,
          connecting: false,
          pending: Buffer.alloc(0),
          antwortPending: Buffer.alloc(0),
          einzel: null,
          clientZu: false,
          upstreamZu: false,
        };
      },
      data(socket, chunk) {
        const state = socket.data;
        switch (state.phase) {
          case 'zu':
            // Abgelehnt/erledigt: end() ist raus, aber die Leseseite lebt bis
            // zum vollständigen Close. Restbytes stumpf verwerfen — sie dürfen
            // NICHT als neuer Request geparst werden.
            return;
          case 'tunnel': {
            // CONNECT: opake Bytes Richtung Upstream, mit Backpressure. Die
            // Grenze ist der Notanker; normal hält pause() den Puffer klein.
            if (state.pending.length + chunk.length > grenze) {
              console.warn(`EgressProxy: pending-Puffer über ${grenze} B — Verbindung getrennt.`);
              beendeBeide(socket);
              return;
            }
            state.pending =
              state.pending.length === 0
                ? Buffer.from(chunk)
                : Buffer.concat([state.pending, chunk]);
            if (state.upstream !== null) flushPending(state, state.upstream);
            // Quelle anhalten, bis der Upstream offen ist bzw. aufgeholt hat
            // (open/drain flushen weiter und resumen dann).
            if (state.pending.length > 0) socket.pause();
            return;
          }
          case 'einzel': {
            const einzel = state.einzel as EinzelRequest;
            const fehlt = einzel.bodySoll - einzel.body.length;
            if (einzel.gesendet || chunk.length > fehlt) {
              // Bytes über den EINEN Request hinaus = zweiter Request.
              // absolute-form ist kein Tunnel: roh weitergereicht käme er
              // mitsamt Proxy-Authorization beim Origin an (Token-Leak).
              // Verbindung beenden — ein noch nicht gesendeter Erst-Request
              // wird dann auch nicht mehr gesendet.
              console.warn(
                'EgressProxy: Bytes über den absolute-form-Request hinaus — Verbindung getrennt.',
              );
              beendeBeide(socket);
              return;
            }
            einzel.body = Buffer.concat([einzel.body, chunk]);
            sendeEinzel(socket);
            return;
          }
          case 'kopf':
            break;
        }

        state.buf = Buffer.concat([state.buf, chunk]);
        const headerEnd = state.buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          if (state.buf.length > 32_768) {
            // Header-Bombe (Defekt 4): NICHT nur die Schreibseite beenden —
            // ohne Phase 'zu' wüchse buf mit jedem weiteren Segment unbegrenzt
            // (Speicherhebel der untrusted VM), und ein nachgereichter
            // Terminator würde doch noch geparst und geproxied.
            macheTerminal(state);
            socket.end();
          }
          return;
        }
        const head = state.buf.subarray(0, headerEnd).toString();
        const rest = state.buf.subarray(headerEnd + 4);
        state.buf = Buffer.alloc(0);

        const parsed = parseProxyHead(head);
        if (parsed === null) {
          macheTerminal(state);
          socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
          socket.end();
          return;
        }
        const { requestLine, headerLines } = parsed;
        const auth =
          headerLines
            .find((l) => l.toLowerCase().startsWith('proxy-authorization:'))
            ?.slice('proxy-authorization:'.length)
            .trim() ?? '';
        if (options.verifyToken(tokenFromAuth(auth)) === null) {
          macheTerminal(state);
          socket.write(
            'HTTP/1.1 407 Proxy Authentication Required\r\n' +
              'Proxy-Authenticate: Basic realm="macvibes"\r\nConnection: close\r\n\r\n',
          );
          socket.end();
          return;
        }

        const [method = '', target = ''] = requestLine.split(' ');
        if (method === 'CONNECT') {
          // CONNECT host:port — TLS wird NICHT aufgebrochen, reiner Tunnel.
          const sep = target.lastIndexOf(':');
          const host = sep > 0 ? target.slice(0, sep) : target;
          const port = sep > 0 ? Number(target.slice(sep + 1)) : 443;
          state.phase = 'tunnel';
          state.connecting = true;
          // Bytes nach dem Kopf gehören in den Tunnel — in Reihenfolge VOR
          // allem, was während der Zielprüfung nachkommt (data-Handler hängt
          // an pending an).
          state.pending = Buffer.from(rest);
          connectChecked(socket, host, port, (up) => {
            anClient(socket, Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'));
            flushPending(state, up);
            // Falls der Client während der Prüfung pausiert wurde und schon
            // alles geflusht ist, wieder lesen; sonst resumed der drain-Handler.
            if (state.pending.length === 0) socket.resume();
          });
          return;
        }
        if (/^https?:\/\//i.test(target)) {
          // absolute-form (http_proxy): auf origin-form umschreiben,
          // Proxy-Header strippen, als EINEN atomaren Request behandeln.
          let url: URL;
          try {
            url = new URL(target);
          } catch {
            macheTerminal(state);
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            socket.end();
            return;
          }
          const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
          if (headerLines.some((l) => l.toLowerCase().startsWith('transfer-encoding:'))) {
            // Chunked-Bodies sind über diesen Proxy exotisch und ohne
            // Content-Length nicht sicher zu framen (Request-Grenze!) —
            // sauber ablehnen statt falsch behandeln.
            macheTerminal(state);
            socket.write(
              'HTTP/1.1 411 Length Required\r\nConnection: close\r\n' +
                'x-macvibes-reason: transfer-encoding wird nicht unterstuetzt, content-length setzen\r\n\r\n',
            );
            socket.end();
            return;
          }
          const bodySoll = contentLengthAus(headerLines);
          if (bodySoll === null) {
            macheTerminal(state);
            socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
            socket.end();
            return;
          }
          if (bodySoll > grenze) {
            macheTerminal(state);
            socket.write('HTTP/1.1 413 Content Too Large\r\nConnection: close\r\n\r\n');
            socket.end();
            return;
          }
          if (rest.length > bodySoll) {
            // Pipelining schon im ersten Segment: Bytes über den einen Request
            // hinaus werden NIE weitergereicht (Token-Leak) — Verbindung zu.
            console.warn(
              'EgressProxy: Bytes über den absolute-form-Request hinaus — Verbindung getrennt.',
            );
            macheTerminal(state);
            socket.end();
            return;
          }
          // Proxy-Header UND vorhandene Connection-Header strippen; wir
          // erzwingen Connection: close, weil die Verbindung nach diesem einen
          // Request nicht als keep-alive wiederverwendet werden darf.
          const forwarded = headerLines.filter(
            (l) => l !== '' && !/^proxy-/i.test(l) && !/^connection:/i.test(l),
          );
          const newHead =
            `${method} ${url.pathname}${url.search} HTTP/1.1\r\n` +
            `${[...forwarded, 'Connection: close'].join('\r\n')}\r\n\r\n`;
          state.phase = 'einzel';
          state.einzel = {
            kopf: Buffer.from(newHead),
            bodySoll,
            body: Buffer.from(rest),
            gesendet: false,
          };
          state.connecting = true;
          connectChecked(socket, url.hostname, port, () => {
            sendeEinzel(socket);
          });
          return;
        }
        macheTerminal(state);
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.end();
      },
      drain(socket) {
        // Der Client nimmt wieder auf: Antwort-Rest weiterschreiben, danach
        // entweder sauber schließen (Upstream ist fertig) oder den pausierten
        // Upstream weiterlesen lassen.
        const state = socket.data;
        if (state.antwortPending.length > 0) {
          state.antwortPending = schreibeMitBackpressure(socket, state.antwortPending);
        }
        if (state.antwortPending.length === 0) {
          if (state.upstreamZu) socket.end();
          else state.upstream?.resume();
        }
      },
      close(socket) {
        const state = socket.data;
        state.clientZu = true;
        // Einen pending-Rest schreibt der Upstream-drain-Handler noch fertig
        // und beendet dann; ohne Rest sofort beenden.
        if (state.upstream !== null && state.pending.length === 0) state.upstream.end();
      },
      error(socket, error) {
        console.error('EgressProxy: Client-Socket-Fehler:', error.message);
        // Terminal (setzt auch clientZu): ein noch nicht gesendeter
        // Erst-Request darf nach einem Client-Fehler nicht mehr raus.
        macheTerminal(socket.data);
        socket.data.upstream?.end();
      },
    },
  });

  return {
    port: listener.port,
    stop: () => listener.stop(true),
  };
}
