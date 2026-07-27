import { createYoga, type Plugin } from 'graphql-yoga';
import { useCookies } from '@whatwg-node/server-plugin-cookies';
import type { Db } from '../db/client';
import type { ServerConfig } from '../config';
import type { SandboxManager } from '../sandbox/sandboxManager';
import type { ChatService } from '../services/chatService';
import { resolveSession } from '../services/authService';
import { readSessionToken } from './cookies';
import { schema } from '../schema';
import type { GraphQLContext } from '../schema/builder';
import { allowedOrigins, isCrossSiteRequest } from './originPolicy';

/** Zusatzdaten, die der HTTP-Server pro Request beisteuert. */
export interface YogaServerContext {
  /** Client-IP für das Rate-Limit (AP6/F14); null, wenn nicht ermittelbar. */
  ip: string | null;
}

export interface AppYogaDeps {
  db: Db;
  config: ServerConfig;
  sandboxManager: SandboxManager;
  chatService: ChatService;
  /** Dev-Port des Vite-Servers — im Dev eine erlaubte Origin. */
  devWebPort?: number | null;
}

function configuredOrigins(): string[] {
  return (Bun.env.MACVIBES_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Lehnt Cross-Site-Schreibzugriffe ab (F6). Die Authentifizierung hängt allein
 * am Ambient-Cookie; ohne diese Prüfung genügt ein HTML-Formular in einer
 * Preview, um eine Mutation im Namen des Betrachters auszulösen.
 */
function useCsrfGuard(deps: AppYogaDeps): Plugin<YogaServerContext> {
  return {
    onRequest({ request, endResponse }) {
      const allowed = allowedOrigins({
        host: request.headers.get('host'),
        configured: configuredOrigins(),
        devWebPort: deps.devWebPort ?? null,
      });
      const crossSite = isCrossSiteRequest({
        method: request.method,
        origin: request.headers.get('origin'),
        secFetchSite: request.headers.get('sec-fetch-site'),
        allowed,
      });
      if (crossSite) {
        endResponse(
          new Response(
            JSON.stringify({
              errors: [{ message: 'Cross-Site-Zugriff auf die macvibes-API ist nicht erlaubt.' }],
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
    },
  };
}

/**
 * Baut den GraphQL-Server. Eigene Datei (statt inline in index.ts), damit die
 * HTTP-Ebene ohne Bun.serve testbar ist — `yoga.fetch(new Request(...))`.
 */
export function createAppYoga(deps: AppYogaDeps) {
  const { db, config, sandboxManager, chatService } = deps;
  return createYoga<YogaServerContext, GraphQLContext>({
    schema,
    graphqlEndpoint: '/graphql',
    landingPage: false,
    // F24: interne Meldungen (git-/msb-stderr, Hostpfade) werden maskiert;
    // DomainError erbt von GraphQLError und bleibt wörtlich sichtbar.
    // MACVIBES_DEBUG_ERRORS=1 hebt die Maskierung für die Fehlersuche auf.
    maskedErrors: Bun.env.MACVIBES_DEBUG_ERRORS === '1' ? false : true,
    // F5: KEIN Default-CORS (spiegelte jede Origin mit Credentials).
    cors: (request) => ({
      origin: allowedOrigins({
        host: request.headers.get('host'),
        configured: configuredOrigins(),
        devWebPort: deps.devWebPort ?? null,
      }),
      credentials: true,
      allowedHeaders: ['content-type'],
      methods: ['GET', 'POST', 'OPTIONS'],
    }),
    plugins: [useCookies(), useCsrfGuard(deps)],
    context: async ({ request }) => {
      const token = await readSessionToken(request);
      const currentUser = token ? await resolveSession(db, config, token) : null;
      return { db, config, currentUser, request, sandboxManager, chatService };
    },
  });
}
