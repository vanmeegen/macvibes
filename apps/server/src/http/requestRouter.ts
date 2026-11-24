import type { AnthropicProxyHandler } from './anthropicProxy';

export interface RequestRouterDeps<TServer> {
  /** Pfad, unter dem sich die Agent-Daemons der VMs per WebSocket einwählen. */
  gatewayPath: string;
  /** WebSocket-Upgrade; `undefined` = Upgrade läuft, es gibt keine HTTP-Antwort. */
  upgradeGateway: (request: Request, server: TServer) => Response | undefined;
  /** GraphQL (bekommt den Server für die Client-IP, Grundlage des Rate-Limits, F14). */
  graphql: (request: Request, server: TServer) => Response | Promise<Response>;
  /** Credential-Proxy für den Agenten in der VM: /anthropic/* → Modell-Upstream. */
  anthropicProxy: AnthropicProxyHandler;
  /** Gebaute Web-UI; null = keine passende Datei. */
  serveStatic: (pathname: string) => Promise<Response | null>;
}

const ANTHROPIC_PREFIX = '/anthropic';

/**
 * Routing des Haupt-Ports: Agent-Gateway, GraphQL, Credential-Proxy, sonst die
 * Web-UI. Generisch über den Server-Typ, damit die Composition Root den
 * Bun-Server durchreicht und Tests einen Platzhalter.
 */
export function createRequestRouter<TServer>(
  deps: RequestRouterDeps<TServer>,
): (request: Request, server: TServer) => Promise<Response | undefined> {
  return async (request, server) => {
    const url = new URL(request.url);
    if (url.pathname === deps.gatewayPath) {
      return deps.upgradeGateway(request, server);
    }
    if (url.pathname === '/graphql') {
      return deps.graphql(request, server);
    }
    if (url.pathname.startsWith(`${ANTHROPIC_PREFIX}/`)) {
      return deps.anthropicProxy(request, url.pathname.slice(ANTHROPIC_PREFIX.length) + url.search);
    }
    const staticResponse = await deps.serveStatic(url.pathname);
    if (staticResponse) return staticResponse;
    return new Response(
      'macvibes-Server läuft. Web-UI: im Dev-Modus http://localhost:5173, sonst apps/web bauen.',
      { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  };
}
