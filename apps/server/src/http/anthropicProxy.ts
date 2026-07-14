/**
 * Credential-Proxy (PRD „Proxy über Host"): Die VM erhält keinerlei
 * Claude-Credentials. Ihr ANTHROPIC_BASE_URL zeigt auf diesen Endpunkt;
 * der Proxy authentifiziert sich mit dem Shared-Secret der Plattform,
 * ersetzt alle Auth-Header und reicht Request/Response (inkl. SSE-Streaming)
 * unverändert an die Claude API durch.
 */

export const PROXY_TOKEN_HEADER = 'x-macvibes-proxy-token';

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

/**
 * Erzwingt bei aktivem Extended Thinking den Stream der Reasoning-Zusammenfassung:
 * Neuere Modelle streamen den Thinking-Text sonst NICHT (nur `signature_delta`,
 * `thinking:""`) — eine Latenz-Optimierung, kein Credential-Effekt. Setzen wir
 * `thinking.display: 'summarized'`, liefert die API `thinking_delta`-Text-Events,
 * die unser Parser/UI als „💭"-Zeile live darstellen kann.
 *
 * Angefasst wird nur ein JSON-Body mit bereits AKTIVEM Thinking und ohne explizit
 * gesetztes `display`. Alles andere (kein Thinking, fremdes `display`, kein/ungültiges
 * JSON) bleibt unverändert — der Proxy darf keine Requests kaputtmachen.
 */
export function injectThinkingDisplay(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (typeof parsed !== 'object' || parsed === null) return bodyText;
  const thinking = (parsed as Record<string, unknown>).thinking;
  if (typeof thinking !== 'object' || thinking === null) return bodyText;
  const t = thinking as Record<string, unknown>;
  // Nur bei AKTIVEM Thinking eingreifen. On-Modi: "adaptive" (die einzige On-Form
  // auf Opus 4.8/4.7/Fable 5) und das ältere "enabled". "disabled"/fehlend bleibt
  // unangetastet, ein bereits gesetztes "summarized" ebenso (idempotent).
  if (t.type !== 'adaptive' && t.type !== 'enabled') return bodyText;
  if (t.display === 'summarized') return bodyText;
  t.display = 'summarized';
  return JSON.stringify(parsed);
}

export interface AnthropicProxyConfig {
  upstreamUrl: string;
  /** Shared Secret VM → Proxy (pro Serverstart zufällig). */
  proxyToken: string;
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
function modelFromBody(bodyText: string | undefined): string | null {
  if (bodyText === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const model = (parsed as Record<string, unknown>)['model'];
    return typeof model === 'string' ? model : null;
  } catch {
    return null;
  }
}

/** Eine Route ist nutzbar, wenn sie irgendeine Auth mitbringen kann. */
function routeUsable(route: ModelRoute): boolean {
  return route.oauthToken != null || route.apiKey != null;
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
    if (request.headers.get(PROXY_TOKEN_HEADER) !== config.proxyToken) {
      return new Response('Ungültiger Proxy-Token', { status: 401 });
    }

    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    // Body puffern und ggf. `thinking.display: summarized` ergänzen, damit die
    // API den Reasoning-Text streamt (statt nur der Signatur). Der Messages-
    // Request ist ein einzelnes JSON — Puffern kostet nichts; content-length
    // setzt fetch neu. Die SSE-ANTWORT bleibt davon unberührt (Streaming).
    const outgoingBody = hasBody ? injectThinkingDisplay(await request.text()) : undefined;
    const route = routeFor(modelFromBody(outgoingBody));
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
