/**
 * Credential-Proxy (PRD „Proxy über Host"): Die VM erhält keinerlei
 * Claude-Credentials. Ihr ANTHROPIC_BASE_URL zeigt auf diesen Endpunkt;
 * der Proxy authentifiziert sich mit dem Shared-Secret der Plattform,
 * ersetzt alle Auth-Header und reicht Request/Response (inkl. SSE-Streaming)
 * unverändert an die Claude API durch.
 */

import { logSafe } from '../logSafe';
// Teil des Host↔VM-Vertrags (core/vmContract): die VM setzt denselben Header
// beim Bau ihrer Agent-Umgebung (agent/vmAgentEnv) — Single Source of Truth
// dort, hier nur re-exportiert für die Proxy-Verwender.
import { PROXY_TOKEN_HEADER } from '../core/vmContract';

export { PROXY_TOKEN_HEADER };

/** Abo-Token (claude setup-token) werden nur mit diesem Beta-Header akzeptiert. */
export const OAUTH_BETA = 'oauth-2025-04-20';

function withOAuthBeta(existing: string | null): string {
  const parts = (existing ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (!parts.includes(OAUTH_BETA)) {
    parts.unshift(OAUTH_BETA);
  }
  return parts.join(',');
}

export interface AufbereiteterBody {
  /** Der (ggf. angepasste) Body, so wie er an den Upstream geht. */
  body: string;
  /** Das angefragte Modell — bestimmt die Route (Claude oder lokaler Router). */
  model: string | null;
}

/**
 * Bereitet den Request-Body in EINEM Durchgang auf: setzt `thinking.display`
 * und liest zugleich das Modell.
 *
 * Zum `display`: Neuere Modelle streamen den Thinking-Text sonst NICHT (nur
 * `signature_delta`, `thinking:""`) — eine Latenz-Optimierung, kein
 * Credential-Effekt. Mit `thinking.display: 'summarized'` liefert die API
 * `thinking_delta`-Text-Events, die unser Parser/UI als „💭"-Zeile live
 * darstellen kann. Angefasst wird nur ein JSON-Body mit bereits AKTIVEM
 * Thinking und ohne explizit gesetztes `display`; alles andere bleibt
 * unverändert — der Proxy darf keine Requests kaputtmachen.
 *
 * Vorher lief das in zwei Schritten — erst parsen + stringifizieren fürs
 * Thinking, dann das Ergebnis erneut parsen, nur um `model` zu lesen. Auf dem
 * heissesten Pfad des Proxys (jeder Agent-Turn) ist das reine Doppelarbeit.
 */
export function prepareRequestBody(bodyText: string): AufbereiteterBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { body: bodyText, model: null };
  }
  if (typeof parsed !== 'object' || parsed === null) return { body: bodyText, model: null };
  const obj = parsed as Record<string, unknown>;
  const rohesModell = obj['model'];
  const model = typeof rohesModell === 'string' ? rohesModell : null;

  const thinking = obj.thinking;
  if (typeof thinking !== 'object' || thinking === null) return { body: bodyText, model };
  const t = thinking as Record<string, unknown>;
  // Nur bei AKTIVEM Thinking eingreifen. On-Modi: "adaptive" (die einzige On-Form
  // auf Opus 4.8/4.7/Fable 5) und das ältere "enabled". "disabled"/fehlend bleibt
  // unangetastet, ein bereits gesetztes "summarized" ebenso (idempotent).
  if (t.type !== 'adaptive' && t.type !== 'enabled') return { body: bodyText, model };
  if (t.display === 'summarized') return { body: bodyText, model };
  t.display = 'summarized';
  return { body: JSON.stringify(parsed), model };
}

/** Nur noch die Thinking-Anpassung — bleibt für die bestehenden Tests erhalten. */
export function injectThinkingDisplay(bodyText: string): string {
  return prepareRequestBody(bodyText).body;
}

export interface AnthropicProxyConfig {
  upstreamUrl: string;
  /** Shared Secret VM → Proxy (pro Serverstart zufällig). */
  /** Prüft das VM-Token und liefert die Identität (F12); null = ungültig. */
  verifyToken: (token: string | null) => { sandbox: string } | null;
  /** Abo-Token (claude setup-token) — bevorzugt. */
  oauthToken: string | null;
  /** Alternativ: klassischer API-Key. */
  apiKey: string | null;
  /**
   * Keepalive-Intervall (ms) für die SSE-Antwort. Bei Sende-Pausen (langsame
   * lokale Modelle: Prefill/Denken ohne Tokens) schiebt der Proxy ein
   * SSE-Kommentar-Frame nach, damit weder Buns Idle-Timeout (max. 255 s) noch
   * die microsandbox-NAT den langlebigen VM→Host-Stream für tot halten und
   * kappen ("Connection closed mid-response"). 0 = aus. Default 10000.
   */
  keepAliveMs?: number | undefined;
  /**
   * Upstream für NICHT-Claude-Modelle (lokaler Router/Shim, z. B. LiteLLM).
   * Der Proxy routet pro Request nach dem `model` im Body: claude-* geht an
   * `upstreamUrl` (mit den Claude-Credentials), alles andere hierhin.
   */
  localUpstreamUrl?: string | undefined;
  /** API-Key für den lokalen Router (LiteLLM/Ollama ignorieren ihn meist). */
  localApiKey?: string | undefined;
  /** Zusätzliche Modell-Routen (OpenRouter-Stil), matchen VOR den Defaults. */
  extraRoutes?: ModelRoute[] | undefined;
  /**
   * Obergrenze für den gepufferten Request-Body in Bytes (H5). Der Proxy
   * materialisiert den Body vollständig (nötig für `injectThinkingDisplay` und
   * die Modellwahl) — ohne Grenze ist das ein Speicher-Hebel für die untrusted
   * VM. Default 32 MiB, das deckt auch Requests mit Bildern.
   */
  maxBodyBytes?: number | undefined;
}

/** Default für `maxBodyBytes` (H5). */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Body als Text lesen, aber höchstens `limit` Bytes (H5). Liefert null, wenn
 * die Grenze überschritten wird — der Rest wird nicht mehr gepuffert.
 */
async function readTextWithLimit(request: Request, limit: number): Promise<string | null> {
  const body = request.body;
  if (body === null) return '';
  const reader = body.getReader();
  const teile: Uint8Array[] = [];
  let gesamt = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      if (value === undefined) continue;
      gesamt += value.byteLength;
      if (gesamt > limit) {
        await reader.cancel();
        return null;
      }
      teile.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const zusammen = new Uint8Array(gesamt);
  let offset = 0;
  for (const teil of teile) {
    zusammen.set(teil, offset);
    offset += teil.byteLength;
  }
  return new TextDecoder().decode(zusammen);
}

/** Eine Modell-Route: Modelle mit `prefix` gehen an `upstreamUrl` mit eigenem Key. */
export interface ModelRoute {
  /** Modell-Prefix ('' = Catch-all). */
  prefix: string;
  upstreamUrl: string;
  /** Klassischer API-Key (x-api-key). */
  apiKey?: string | null | undefined;
  /** Abo-/Bearer-Token (authorization: Bearer …, mit OAuth-Beta-Flag). */
  oauthToken?: string | null | undefined;
}

/**
 * Hält einen SSE-Stream „warm": leitet Upstream-Bytes unverändert durch, injiziert
 * aber ein SSE-Kommentar-Frame (`: keepalive\n\n`, von jedem SSE-Client ignoriert),
 * wenn länger als `intervalMs` KEIN Upstream-Byte fließt. Injiziert nur in echten
 * Sende-Pausen — die liegen an Frame-Grenzen (nach `\n\n`), nie mitten in einem
 * Event, das der Upstream Token für Token komplett flusht.
 */
function withKeepAlive(
  upstream: ReadableStream<Uint8Array>,
  intervalMs: number,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const ping = new TextEncoder().encode(': keepalive\n\n');
  const IDLE = Symbol('idle');
  // Ausstehender read(), falls der Keepalive-Timer vor dem nächsten Chunk feuert
  // (pro Reader darf immer nur EIN read() gleichzeitig laufen).
  let pendingRead: ReturnType<typeof reader.read> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const read = pendingRead ?? reader.read();
      pendingRead = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<typeof IDLE>((resolve) => {
        timer = setTimeout(() => resolve(IDLE), intervalMs);
      });
      try {
        const winner = await Promise.race([read, idle]);
        if (winner === IDLE) {
          pendingRead = read; // denselben read() nächste Runde weiter abwarten
          controller.enqueue(ping);
          return;
        }
        const { done, value } = winner;
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

export type AnthropicProxyHandler = (request: Request, upstreamPath: string) => Promise<Response>;

/** Modellname aus dem (JSON-)Request-Body — null bei GET/kein JSON/kein model. */
/** Eine Route ist nutzbar, wenn sie irgendeine Auth mitbringen kann. */
function routeUsable(route: ModelRoute): boolean {
  return route.oauthToken != null || route.apiKey != null;
}

/**
 * Pfad-Allowlist (H9). Der Gast bestimmt `upstreamPath` vollständig — ohne
 * diese Prüfung klebt der Proxy ihn an den Upstream und die untrusted VM
 * erreicht damit JEDEN Endpunkt: bei der Catch-all-Route den auth-losen
 * lokalen Router auf dem Host-Loopback (den die Egress-Policy bewusst sperrt),
 * bei der Claude-Route die gesamte API-Fläche mit dem Host-Token statt nur
 * Inferenz. Erlaubt ist deshalb nur, was der Agent wirklich braucht.
 */
const ALLOWED_PATHS: ReadonlyArray<{ pathname: RegExp; methods: ReadonlyArray<string> }> = [
  { pathname: /^\/v1\/messages$/, methods: ['POST'] },
  { pathname: /^\/v1\/messages\/count_tokens$/, methods: ['POST'] },
  // Modell-Liste und Einzelabfrage: nur lesend.
  { pathname: /^\/v1\/models$/, methods: ['GET'] },
  { pathname: /^\/v1\/models\/[A-Za-z0-9._-]+$/, methods: ['GET'] },
];

export type PathVerdict = 'ok' | 'unbekannter-pfad' | 'falsche-methode';

/**
 * Prüft den gastgewählten Pfad gegen die Allowlist. `upstreamPath` ist
 * `<pathname><search>`; die Query bleibt frei (z. B. `?beta=true`), der
 * Pfad selbst muss exakt passen — Groß-/Kleinschreibung und `..` inklusive.
 */
export function checkUpstreamPath(upstreamPath: string, method: string): PathVerdict {
  const queryStart = upstreamPath.indexOf('?');
  const pathname = queryStart === -1 ? upstreamPath : upstreamPath.slice(0, queryStart);
  const matched = ALLOWED_PATHS.filter((entry) => entry.pathname.test(pathname));
  if (matched.length === 0) return 'unbekannter-pfad';
  if (!matched.some((entry) => entry.methods.includes(method))) return 'falsche-methode';
  return 'ok';
}

export function createAnthropicProxy(config: AnthropicProxyConfig): AnthropicProxyHandler {
  // Routen-Tabelle (Reihenfolge = Priorität): Zusatz-Routen (OpenRouter-Stil),
  // dann claude-* an die Anthropic-API, dann Catch-all an den lokalen Router.
  // Claude Code ruft intern auch Hilfsmodelle (claude-haiku-*) auf — fehlt der
  // Claude-Zugang, fallen die auf den lokalen Router zurück (Wildcard im Shim).
  const routes: ModelRoute[] = [
    ...(config.extraRoutes ?? []),
    {
      prefix: 'claude',
      upstreamUrl: config.upstreamUrl,
      oauthToken: config.oauthToken,
      apiKey: config.apiKey,
    },
    // Catch-all an den lokalen Router — nur wenn einer konfiguriert ist.
    ...(config.localUpstreamUrl !== undefined
      ? [
          {
            prefix: '',
            upstreamUrl: config.localUpstreamUrl,
            apiKey: config.localApiKey ?? 'local',
          },
        ]
      : []),
  ];
  const routeFor = (model: string | null): ModelRoute | null => {
    // Ohne Modell (GET /v1/models u. Ä.): erste nutzbare Route = primäre API.
    const candidates = routes.filter((route) => model === null || model.startsWith(route.prefix));
    return candidates.find(routeUsable) ?? null;
  };

  return async (request, upstreamPath) => {
    if (config.verifyToken(request.headers.get(PROXY_TOKEN_HEADER)) === null) {
      return new Response('Ungültiger Proxy-Token', { status: 401 });
    }

    // Allowlist VOR dem Puffern des Bodys (H9): ein abgewiesener Pfad darf der
    // VM nicht einmal den Speicher-Hebel des Puffers lassen.
    const verdict = checkUpstreamPath(upstreamPath, request.method);
    if (verdict !== 'ok') {
      // Sichtbar machen, statt still zu brechen: sollte der Agent je einen
      // legitimen Pfad brauchen, der hier fehlt, steht er im Log (H8: der
      // Pfad ist gastkontrolliert und muss escaped werden).
      console.warn(
        `Credential-Proxy: Pfad abgewiesen (${verdict}) — ` +
          `${logSafe(request.method)} ${logSafe(upstreamPath)}`,
      );
      return verdict === 'unbekannter-pfad'
        ? new Response('Pfad nicht erlaubt', { status: 404 })
        : new Response('Methode nicht erlaubt', { status: 405 });
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    // Angekündigte Größe zuerst prüfen (H5): so wird gar nicht gepuffert, wenn
    // die VM schon im Header zu viel ankündigt.
    const angekuendigt = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(angekuendigt) && angekuendigt > maxBodyBytes) {
      return new Response('Request-Body zu groß', { status: 413 });
    }
    // Body puffern und ggf. `thinking.display: summarized` ergänzen, damit die
    // API den Reasoning-Text streamt (statt nur der Signatur). Der Messages-
    // Request ist ein einzelnes JSON — content-length setzt fetch neu. Die
    // SSE-ANTWORT bleibt davon unberührt (Streaming).
    let outgoingBody: string | undefined;
    let angefragtesModell: string | null = null;
    if (hasBody) {
      const roh = await readTextWithLimit(request, maxBodyBytes);
      if (roh === null) {
        // Auch eine gelogene/fehlende content-length fängt die Grenze noch ab.
        return new Response('Request-Body zu groß', { status: 413 });
      }
      const aufbereitet = prepareRequestBody(roh);
      outgoingBody = aufbereitet.body;
      angefragtesModell = aufbereitet.model;
    }
    const route = routeFor(angefragtesModell);
    if (route === null) {
      return new Response(
        'Keine nutzbare Modell-Route — CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) ' +
          'oder ANTHROPIC_API_KEY in apps/server/.env setzen (bzw. den lokalen Router konfigurieren).',
        { status: 503 },
      );
    }

    const headers = new Headers(request.headers);
    headers.delete(PROXY_TOKEN_HEADER);
    headers.delete('authorization');
    headers.delete('x-api-key');
    headers.delete('host');
    // Unkomprimiert anfordern: sonst kollidieren content-encoding und der
    // (von Bun beim Durchreichen ent-/gepackte) Body → ZlibError im Client.
    headers.delete('accept-encoding');
    // Body wird gepuffert und ggf. umgeschrieben — alte Länge verwerfen, fetch
    // setzt content-length passend zum tatsächlich gesendeten Body neu.
    headers.delete('content-length');
    if (route.oauthToken != null) {
      headers.set('authorization', `Bearer ${route.oauthToken}`);
      // Abo-Token braucht das OAuth-Beta-Flag (sonst 401), bestehende Betas erhalten.
      headers.set('anthropic-beta', withOAuthBeta(headers.get('anthropic-beta')));
    } else if (route.apiKey != null) {
      headers.set('x-api-key', route.apiKey);
    }

    const upstreamUrl = `${route.upstreamUrl}${upstreamPath}`;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        ...(hasBody ? { body: outgoingBody } : {}),
      } as RequestInit);
    } catch (error) {
      // Upstream (z. B. lokaler Router) nicht erreichbar — klare 502 statt 500.
      return new Response(
        `Modell-Upstream nicht erreichbar (${route.upstreamUrl}): ${String(error)}`,
        { status: 502 },
      );
    }

    // fetch dekomprimiert den Body bereits — content-encoding/-length der
    // Upstream-Antwort passen dann nicht mehr zum durchgereichten Body und
    // führen im Client zu einer zweiten Dekompression (ZlibError).
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    responseHeaders.delete('transfer-encoding');

    // SSE-Streams über Keepalive warmhalten (nur relevant/sicher bei
    // text/event-stream). Nicht-Streams (einzelnes JSON) unverändert durchreichen.
    const keepAliveMs = config.keepAliveMs ?? 10_000;
    const isEventStream = (responseHeaders.get('content-type') ?? '').includes('text/event-stream');
    const body =
      upstreamResponse.body !== null && isEventStream && keepAliveMs > 0
        ? withKeepAlive(upstreamResponse.body, keepAliveMs)
        : upstreamResponse.body;

    return new Response(body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  };
}
