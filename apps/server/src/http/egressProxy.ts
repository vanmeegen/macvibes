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

export interface EgressProxyOptions {
  port: number;
  /** Shared Secret (Basic-Auth-Passwort in der Proxy-URL der VM). */
  token: string;
  hostname?: string;
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
  const expectedAuth = `Basic ${Buffer.from(`mv:${options.token}`).toString('base64')}`;

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

        const lines = head.split('\r\n');
        const requestLine = lines[0] ?? '';
        const headerLines = lines.slice(1);
        const auth =
          headerLines
            .find((l) => l.toLowerCase().startsWith('proxy-authorization:'))
            ?.slice('proxy-authorization:'.length)
            .trim() ?? '';
        if (auth !== expectedAuth) {
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
          connectUpstream(socket, host, port, (up) => {
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
          connectUpstream(socket, url.hostname, port, (up) => {
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
