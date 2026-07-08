import type { ServerWebSocket } from 'bun';

/**
 * Preview-Gateway: EIN fester Port, der jede Projekt-Preview auf ihren
 * dynamischen VM-Host-Port reverse-proxied. Zweck: Remote-/VPN-Zugriff. Der
 * Nutzer forwardet nur diesen einen Port (wie 5173/4000) statt der zufälligen
 * hohen Preview-Ports, die der WireGuard-/Router-Pfad nicht durchreicht.
 *
 * Die Preview behält ihre EIGENE Origin (`http://host:<gatewayPort>/`), damit
 * root-absolute Asset-Pfade der Dev-Server (Vite `/@vite/client`, Bun
 * `/_bun/...`) unverändert auflösen — kein `base`-Rewrite, funktioniert für
 * beide Templates. Zuordnung Request→Projekt: Einstiegspfad `/p/<id>/` setzt
 * einen Cookie; root-absolute Folge-Requests werden primär über den `Referer`
 * (parallelfest), sonst über den Cookie geroutet.
 */

const COOKIE_NAME = 'mvp';
const ENTRY_RE = /^\/p\/([^/]+)(\/.*)?$/;

export interface PreviewTarget {
  projectId: string;
  /** Pfad, wie er an den VM-Dev-Server weitergereicht wird (VM-Root = `/`). */
  forwardPath: string;
  /** Am Einstieg (`/p/<id>/`) den Routing-Cookie setzen. */
  setCookie: boolean;
}

/** Extrahiert die projectId aus einem `/p/<id>/…`-Pfad (z. B. aus dem Referer). */
function idFromPPath(pathname: string): string | null {
  const m = pathname.match(ENTRY_RE);
  return m ? decodeURIComponent(m[1] as string) : null;
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Reine Zuordnung eines eingehenden Requests zu einem Projekt + Forward-Pfad.
 * Reihenfolge: Einstiegspfad `/p/<id>/` → Referer → Cookie. Null, wenn nichts
 * greift (dann 503).
 */
export function resolveTarget(input: {
  pathname: string;
  referer: string | null;
  cookie: string | null;
}): PreviewTarget | null {
  const entry = input.pathname.match(ENTRY_RE);
  if (entry) {
    const rest = entry[2];
    return {
      projectId: decodeURIComponent(entry[1] as string),
      forwardPath: rest === undefined || rest === '' ? '/' : rest,
      setCookie: true,
    };
  }

  let refererPath: string | null = null;
  if (input.referer !== null) {
    try {
      refererPath = new URL(input.referer).pathname;
    } catch {
      refererPath = null;
    }
  }
  const fromReferer = refererPath !== null ? idFromPPath(refererPath) : null;
  if (fromReferer !== null) {
    return { projectId: fromReferer, forwardPath: input.pathname, setCookie: false };
  }

  const fromCookie = cookieValue(input.cookie, COOKIE_NAME);
  if (fromCookie !== null) {
    return { projectId: fromCookie, forwardPath: input.pathname, setCookie: false };
  }
  return null;
}

export interface PreviewGatewayOptions {
  port: number;
  hostname?: string;
  /** Liefert den Host-Port der laufenden Preview-VM (null = nicht bereit). */
  previewPortFor: (projectId: string) => number | null;
}

export interface PreviewGatewayHandle {
  port: number;
  stop: () => void;
}

interface WsProxyData {
  vmPort: number;
  path: string;
  protocol: string | null;
  upstream: WebSocket | null;
  ready: boolean;
  pending: (string | Buffer)[];
}

const NOT_READY_HTML =
  '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;color:#888;' +
  'background:#0d0d0d;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
  'Preview nicht bereit …</body>';

function notReady(): Response {
  return new Response(NOT_READY_HTML, {
    status: 503,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/** Startet das Preview-Gateway (HTTP + WS-Reverse-Proxy). */
export function startPreviewGateway(options: PreviewGatewayOptions): PreviewGatewayHandle {
  const { previewPortFor } = options;

  const server = Bun.serve<WsProxyData>({
    port: options.port,
    hostname: options.hostname ?? '0.0.0.0',
    async fetch(req, srv): Promise<Response | undefined> {
      const url = new URL(req.url);
      const target = resolveTarget({
        pathname: url.pathname,
        referer: req.headers.get('referer'),
        cookie: req.headers.get('cookie'),
      });
      if (target === null) return notReady();
      const vmPort = previewPortFor(target.projectId);
      if (vmPort === null) return notReady();

      // HMR-WebSocket-Upgrade an den VM-Dev-Server durchreichen.
      if ((req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
        const upgraded = srv.upgrade(req, {
          data: {
            vmPort,
            path: target.forwardPath + url.search,
            protocol: req.headers.get('sec-websocket-protocol'),
            upstream: null,
            ready: false,
            pending: [],
          },
        });
        return upgraded ? undefined : new Response('WS-Upgrade fehlgeschlagen', { status: 400 });
      }

      const headers = new Headers(req.headers);
      headers.delete('host');
      // Unkomprimiert holen — dann stimmen die weitergereichten Längen/Encodings.
      headers.delete('accept-encoding');
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      let upstream: Response;
      try {
        upstream = await fetch(`http://127.0.0.1:${vmPort}${target.forwardPath}${url.search}`, {
          method: req.method,
          headers,
          body: hasBody ? req.body : undefined,
          redirect: 'manual',
          // Streaming-Body erfordert duplex:'half' (Bun/undici).
          ...(hasBody ? { duplex: 'half' } : {}),
        } as RequestInit);
      } catch {
        return notReady();
      }

      const respHeaders = new Headers(upstream.headers);
      if (target.setCookie) {
        respHeaders.append(
          'set-cookie',
          `${COOKIE_NAME}=${encodeURIComponent(target.projectId)}; Path=/; SameSite=Lax`,
        );
      }
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    },
    websocket: {
      open(ws: ServerWebSocket<WsProxyData>) {
        const url = `ws://127.0.0.1:${ws.data.vmPort}${ws.data.path}`;
        const upstream =
          ws.data.protocol !== null ? new WebSocket(url, ws.data.protocol) : new WebSocket(url);
        ws.data.upstream = upstream;
        upstream.addEventListener('open', () => {
          ws.data.ready = true;
          for (const m of ws.data.pending) upstream.send(m);
          ws.data.pending = [];
        });
        upstream.addEventListener('message', (e: MessageEvent) =>
          ws.send(e.data as string | Buffer),
        );
        upstream.addEventListener('close', () => ws.close());
        upstream.addEventListener('error', () => ws.close());
      },
      message(ws: ServerWebSocket<WsProxyData>, message: string | Buffer) {
        const upstream = ws.data.upstream;
        if (upstream !== null && ws.data.ready) upstream.send(message);
        else ws.data.pending.push(message);
      },
      close(ws: ServerWebSocket<WsProxyData>) {
        ws.data.upstream?.close();
      },
    },
  });

  return {
    port: server.port ?? options.port,
    stop: () => server.stop(true),
  };
}
