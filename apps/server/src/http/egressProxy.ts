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

interface ConnState {
  buf: Buffer;
  upstream: Socket | null;
  established: boolean;
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
      client.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      client.end();
    });
  };

  const listener: TCPSocketListener<ConnState> = Bun.listen<ConnState>({
    hostname: options.hostname ?? '0.0.0.0',
    port: options.port,
    socket: {
      open(socket) {
        socket.data = { buf: Buffer.alloc(0), upstream: null, established: false };
      },
      data(socket, chunk) {
        const state = socket.data;
        // Tunnel steht: Bytes 1:1 durchreichen.
        if (state.established && state.upstream) {
          state.upstream.write(chunk);
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
          connectChecked(socket, host, port, (up) => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            state.established = true;
            if (rest.length > 0) up.write(rest);
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
          connectChecked(socket, url.hostname, port, (up) => {
            state.established = true;
            up.write(newHead);
            if (rest.length > 0) up.write(rest);
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
