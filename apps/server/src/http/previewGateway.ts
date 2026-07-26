import type { ServerWebSocket } from 'bun';
import { SESSION_COOKIE } from './cookies';

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

/**
 * Header, die niemals in die (nicht vertrauenswürdige) VM gelangen dürfen.
 * `cookie` wird nicht gelöscht, sondern gefiltert — Preview-Apps dürfen eigene
 * Cookies haben, nur unsere nicht.
 */
const STRIP_TO_UPSTREAM = ['host', 'accept-encoding', 'authorization', 'proxy-authorization'];

/** Cookies, die dem Host gehören und in der VM nichts zu suchen haben. */
const HOST_COOKIES = new Set([SESSION_COOKIE, COOKIE_NAME]);

/** Header, die die VM dem Browser nicht diktieren darf. */
const STRIP_FROM_UPSTREAM = ['strict-transport-security', 'clear-site-data'];

/**
 * Request-Header für den Weg zur VM säubern (F2). Das Session-Cookie ist der
 * kritische Teil: Cookies sind nicht portgebunden, der Browser hängt es also
 * auch an Preview-Requests — der Dev-Server in der VM bekäme sonst den
 * Session-Token jedes Betrachters, und `httpOnly` hilft nicht, weil er als
 * gewöhnlicher Header ankommt.
 */
export function sanitizeUpstreamHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of STRIP_TO_UPSTREAM) out.delete(name);

  const cookie = headers.get('cookie');
  if (cookie === null) return out;
  const kept = cookie
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const eq = part.indexOf('=');
      const name = eq === -1 ? part : part.slice(0, eq);
      return !HOST_COOKIES.has(name.trim());
    });
  if (kept.length === 0) out.delete('cookie');
  else out.set('cookie', kept.join('; '));
  return out;
}

/**
 * Antwort-Header der VM säubern (F11). Die VM darf keine Cookies für unseren
 * Routing-Namen setzen (sonst lenkt sie den Browser auf ein fremdes Projekt)
 * und keine site-weiten Direktiven wie HSTS diktieren. Eigene Cookies der
 * Preview-App bleiben erhalten — die braucht sie für ihren eigenen Zustand.
 */
export function sanitizeDownstreamHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of STRIP_FROM_UPSTREAM) out.delete(name);

  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) {
    out.delete('set-cookie');
    for (const cookie of cookies) {
      const eq = cookie.indexOf('=');
      const name = (eq === -1 ? cookie : cookie.slice(0, eq)).trim();
      if (!HOST_COOKIES.has(name)) out.append('set-cookie', cookie);
    }
  }
  return out;
}

export interface PreviewGatewayOptions {
  port: number;
  hostname?: string;
  /** Liefert den Host-Port der laufenden Preview-VM (null = nicht bereit). */
  previewPortFor: (projectId: string) => number | null;
  /**
   * Prüft den Session-Token aus dem Cookie (F19). Pflichtfeld: das Gateway
   * lauscht auf 0.0.0.0 und wird für Remote-Zugriff bewusst geforwardet — ohne
   * Prüfung erreicht jeder mit einer Projekt-ID jede laufende Preview.
   */
  authenticate: (sessionToken: string | null) => Promise<boolean>;
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

const UNAUTHORIZED_HTML =
  '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;color:#888;' +
  'background:#0d0d0d;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
  'Bitte zuerst in macvibes anmelden.</body>';

function unauthorized(): Response {
  return new Response(UNAUTHORIZED_HTML, {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/**
 * Kurzlebiger Positiv-Cache für Session-Prüfungen. Eine Preview-Seite löst
 * Dutzende Asset-Requests aus, und `resolveSession` verlängert die Session
 * rollierend — ohne Cache wäre das ein SQLite-Write pro Asset.
 */
const AUTH_CACHE_MS = 30_000;

function createAuthCache(
  authenticate: (token: string | null) => Promise<boolean>,
): (token: string | null) => Promise<boolean> {
  const seen = new Map<string, number>();
  return async (token) => {
    // Ohne Token gibt es nichts zu cachen — die Entscheidung trifft der
    // Callback, damit die Policy an einer Stelle liegt.
    if (token === null) return authenticate(null);
    const now = Date.now();
    const until = seen.get(token);
    if (until !== undefined && until > now) return true;
    const ok = await authenticate(token);
    if (ok) {
      seen.set(token, now + AUTH_CACHE_MS);
      // Abgelaufene Einträge aufräumen, damit die Map nicht unbegrenzt wächst.
      for (const [key, expiry] of seen) if (expiry <= now) seen.delete(key);
    }
    return ok;
  };
}

/** Startet das Preview-Gateway (HTTP + WS-Reverse-Proxy). */
export function startPreviewGateway(options: PreviewGatewayOptions): PreviewGatewayHandle {
  const { previewPortFor } = options;
  const isAuthenticated = createAuthCache(options.authenticate);

  const server = Bun.serve<WsProxyData>({
    port: options.port,
    hostname: options.hostname ?? '0.0.0.0',
    async fetch(req, srv): Promise<Response | undefined> {
      const url = new URL(req.url);
      // Auth VOR jeder Auflösung — die VM darf nicht einmal kontaktiert
      // werden, solange die Session nicht steht (F19). Gilt auch für den
      // WS-Upgrade, sonst wäre die Prüfung über HMR umgehbar.
      if (!(await isAuthenticated(cookieValue(req.headers.get('cookie'), SESSION_COOKIE)))) {
        return unauthorized();
      }
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

      // Session-Cookie und Auth-Header bleiben auf dem Host (F2);
      // accept-encoding entfällt, damit Längen/Encodings weiter stimmen.
      const headers = sanitizeUpstreamHeaders(req.headers);
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

      const respHeaders = sanitizeDownstreamHeaders(upstream.headers);
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
