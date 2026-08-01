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
  /** Obergrenze des pending-Puffers pro Verbindung (Default 8 MiB). Test-Naht. */
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

export interface EgressProxyHandle {
  port: number;
  stop: () => void;
}

/**
 * Obergrenze für den `pending`-Puffer einer Verbindung (H5-analog). Der Puffer
 * hält Bytes, solange der Upstream noch nicht (vollständig) aufnahmebereit ist
 * — während der asynchronen Zielprüfung und bei Backpressure. Ohne Grenze ist
 * er ein Speicher-Hebel für die per Design nicht vertrauenswürdige MicroVM: ein
 * `CONNECT` auf einen langsam auflösenden Hostnamen plus Dauerfeuer triebe den
 * Host-RSS bis zum OOM. 8 MiB deckt legitime grosse Bodies in der kurzen
 * Prüfphase und begrenzt zugleich den Schaden.
 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** Der Ausschnitt eines Bun-Sockets, den `flushPending` braucht (Test-Naht). */
export interface WritableSocket {
  write(data: Uint8Array): number;
}

interface ConnState {
  buf: Buffer;
  upstream: Socket | null;
  /** Upstream verbunden UND `pending` vollständig geflusht — direkter Pfad. */
  established: boolean;
  /** Zielprüfung (DNS + Policy) läuft — sie ist asynchron. */
  connecting: boolean;
  /**
   * Bytes, die zum laufenden Request gehören, aber noch nicht (vollständig) an
   * den Upstream geschrieben sind: während der Zielprüfung (typischerweise der
   * POST-Body in einem eigenen TCP-Segment) und der ungeschriebene Rest bei
   * Backpressure. Als Request-Kopf geparst hätte das zu sporadischen „400 Bad
   * Request" geführt; verworfen zu truncierten Requests.
   */
  pending: Buffer;
}

/**
 * Schreibt so viel von `pending` an den Upstream, wie der Socket annimmt, und
 * behält den ungeschriebenen Rest.
 *
 * Bun's `Socket.write` schreibt bei vollem Kernel-Puffer WENIGER als übergeben
 * und meldet die tatsächlich geschriebene Zahl — der Rest muss aufgehoben und
 * beim `drain`-Event erneut geschrieben werden. Ihn (wie zuvor) bedingungslos
 * zu verwerfen, trunciert den Request: der Upstream bekommt weniger als seine
 * content-length ankündigt und hängt bis zum Timeout.
 *
 * `established` wird erst gesetzt, wenn `pending` LEER ist. Solange noch ein
 * Rest aussteht, müssen neue Bytes weiter über `pending` laufen — schriebe der
 * data-Handler sie schon direkt an den Upstream, überholten sie den Rest und
 * die Reihenfolge bräche.
 */
export function flushPending(state: ConnState, up: WritableSocket): void {
  while (state.pending.length > 0) {
    const geschrieben = up.write(state.pending);
    // <= 0: Socket zu oder komplett gepuffert — der drain-Handler macht weiter.
    if (typeof geschrieben !== 'number' || geschrieben <= 0) break;
    state.pending =
      geschrieben >= state.pending.length
        ? Buffer.alloc(0)
        : Buffer.from(state.pending.subarray(geschrieben));
  }
  state.connecting = false;
  if (state.pending.length === 0) state.established = true;
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

  const refuse = (client: Socket<ConnState>, reason: string): void => {
    console.warn(`EgressProxy: Ziel abgelehnt — ${reason}`);
    // Puffer freigeben und das connecting-Flag löschen: die Verbindung wird
    // geschlossen, aber bis der Close greift, könnten sonst weiter Bytes
    // auflaufen (der Upstream kommt ja nie, flushPending läuft nie).
    client.data.pending = Buffer.alloc(0);
    client.data.connecting = false;
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
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(up) {
          client.data.upstream = up;
          onOpen(up);
        },
        drain(up) {
          // Kernel-Puffer hat wieder Platz — ausstehende pending-Bytes weiter
          // an den Upstream schreiben (Backpressure, s. flushPending).
          if (client.data.pending.length > 0) flushPending(client.data, up);
        },
        data(_up, chunk) {
          client.write(chunk);
        },
        close() {
          client.end();
        },
        error(_up, error) {
          console.error(`EgressProxy: Upstream-Fehler ${host}:${port}:`, error.message);
          client.end();
        },
      },
    }).catch((error: unknown) => {
      console.error(`EgressProxy: Connect zu ${host}:${port} fehlgeschlagen:`, error);
      // Wie bei refuse: kein Upstream, also läuft flushPending nie — Puffer
      // freigeben, damit bis zum Close nichts mehr aufläuft.
      client.data.pending = Buffer.alloc(0);
      client.data.connecting = false;
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
          established: false,
          connecting: false,
          pending: Buffer.alloc(0),
        };
      },
      data(socket, chunk) {
        const state = socket.data;
        // Tunnel steht und pending ist leer: Bytes 1:1 durchreichen.
        if (state.established && state.upstream) {
          state.upstream.write(chunk);
          return;
        }
        // Bytes gehören zum laufenden Request, der Upstream ist aber noch nicht
        // (vollständig) aufnahmebereit: während der Zielprüfung (kein Upstream)
        // oder solange ein pending-Rest bei Backpressure aussteht. Aufheben —
        // mit Obergrenze, sonst ist der Puffer ein OOM-Hebel für die untrusted
        // VM.
        if (state.connecting || state.upstream !== null) {
          const grenze = options.maxPendingBytes ?? MAX_PENDING_BYTES;
          if (state.pending.length + chunk.length > grenze) {
            console.warn(`EgressProxy: pending-Puffer über ${grenze} B — Verbindung getrennt.`);
            socket.end();
            return;
          }
          state.pending = Buffer.concat([state.pending, chunk]);
          // Upstream schon da (Backpressure-Phase): sofort nachschieben.
          if (state.upstream !== null) flushPending(state, state.upstream);
          return;
        }
        state.buf = Buffer.concat([state.buf, chunk]);
        const headerEnd = state.buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          if (state.buf.length > 32_768) socket.end(); // Header-Bombe
          return;
        }
        const head = state.buf.subarray(0, headerEnd).toString();
        const rest = state.buf.subarray(headerEnd + 4);
        state.buf = Buffer.alloc(0);

        const parsed = parseProxyHead(head);
        if (parsed === null) {
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
          state.connecting = true;
          connectChecked(socket, host, port, (up) => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            // Alles über pending schreiben, in Reihenfolge: erst der Rest aus
            // demselben Segment, dann was während der Prüfung nachkam.
            // flushPending achtet auf Backpressure und setzt established, sobald
            // pending leer ist.
            state.pending = rest.length > 0 ? Buffer.concat([rest, state.pending]) : state.pending;
            flushPending(state, up);
          });
          return;
        }
        if (/^https?:\/\//i.test(target)) {
          // absolute-form (http_proxy): auf origin-form umschreiben, proxy-Header strippen.
          let url: URL;
          try {
            url = new URL(target);
          } catch {
            socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
            socket.end();
            return;
          }
          const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
          const forwarded = headerLines.filter((l) => !/^proxy-/i.test(l));
          const newHead =
            `${method} ${url.pathname}${url.search} HTTP/1.1\r\n` +
            `${forwarded.join('\r\n')}\r\n\r\n`;
          state.connecting = true;
          connectChecked(socket, url.hostname, port, (up) => {
            // newHead + rest + pending in Reihenfolge über den Puffer, damit
            // Backpressure und Reihenfolge korrekt behandelt werden.
            state.pending = Buffer.concat([Buffer.from(newHead), rest, state.pending]);
            flushPending(state, up);
          });
          return;
        }
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.end();
      },
      close(socket) {
        socket.data.upstream?.end();
      },
      error(socket, error) {
        console.error('EgressProxy: Client-Socket-Fehler:', error.message);
        socket.data.upstream?.end();
      },
    },
  });

  return {
    port: listener.port,
    stop: () => listener.stop(true),
  };
}
