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
}

export type AnthropicProxyHandler = (request: Request, upstreamPath: string) => Promise<Response>;

export function createAnthropicProxy(config: AnthropicProxyConfig): AnthropicProxyHandler {
  return async (request, upstreamPath) => {
    if (request.headers.get(PROXY_TOKEN_HEADER) !== config.proxyToken) {
      return new Response('Ungültiger Proxy-Token', { status: 401 });
    }
    if (config.oauthToken === null && config.apiKey === null) {
      return new Response(
        'Keine Claude-Credentials konfiguriert — CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) ' +
          'oder ANTHROPIC_API_KEY in apps/server/.env setzen.',
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
    if (config.oauthToken !== null) {
      headers.set('authorization', `Bearer ${config.oauthToken}`);
      // Abo-Token braucht das OAuth-Beta-Flag (sonst 401), bestehende Betas erhalten.
      headers.set('anthropic-beta', withOAuthBeta(headers.get('anthropic-beta')));
    } else if (config.apiKey !== null) {
      headers.set('x-api-key', config.apiKey);
    }

    const upstreamUrl = `${config.upstreamUrl}${upstreamPath}`;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    // Body puffern und ggf. `thinking.display: summarized` ergänzen, damit die
    // API den Reasoning-Text streamt (statt nur der Signatur). Der Messages-
    // Request ist ein einzelnes JSON — Puffern kostet nichts; content-length
    // setzt fetch neu. Die SSE-ANTWORT bleibt davon unberührt (Streaming).
    const outgoingBody = hasBody ? injectThinkingDisplay(await request.text()) : undefined;
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      ...(hasBody ? { body: outgoingBody } : {}),
    } as RequestInit);

    // fetch dekomprimiert den Body bereits — content-encoding/-length der
    // Upstream-Antwort passen dann nicht mehr zum durchgereichten Body und
    // führen im Client zu einer zweiten Dekompression (ZlibError).
    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
    responseHeaders.delete('transfer-encoding');
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  };
}
