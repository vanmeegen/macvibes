import { GraphQLError, type GraphQLErrorOptions } from 'graphql';
import {
  createLogger,
  createYoga,
  maskError as yogaMaskError,
  type Plugin,
  type YogaLogger,
} from 'graphql-yoga';
import { useCookies } from '@whatwg-node/server-plugin-cookies';
import { DomainError } from '../core/errors';
import type { Db } from '../db/client';
import type { ServerConfig } from '../config';
import type { SandboxManager } from '../sandbox/sandboxManager';
import type { ChatService } from '../services/chatService';
import { resolveSession } from '../services/authService';
import {
  clearSessionCookie,
  isSecureRequest,
  readSessionToken,
  writeSessionCookie,
} from './cookies';
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
}

/**
 * F24: interne Meldungen (git-/msb-stderr, Hostpfade, fs-Fehler) werden von
 * Yogas Standard-Maskierung verschluckt; DomainErrors (deutsche, nutzer-
 * präsentierbare Messages aus core/services/sandbox — inkl. Subklassen wie
 * SandboxCapacityError) bewusst nicht. Seit DomainError ein reiner Error ist
 * (core kennt kein GraphQL, M3), fällt diese Entscheidung HIER — am einzigen
 * Ort, der die Präsentationstechnik kennt. `extensions.code = 'DOMAIN_ERROR'`
 * ist dabei API-Vertrag und bleibt erhalten.
 *
 * Der durchgereichte Fehler wird bewusst OHNE `originalError` neu gebaut:
 * mit gesetztem originalError (ein Nicht-GraphQLError) zählte Yoga ihn als
 * „unexpected" und antwortete auf Request-Ebene mit 500 statt 200.
 */
function maskInternalErrors(error: unknown, message: string, isDev?: boolean): Error {
  // Resolver-Fehler kommen als GraphQLError-Hülle mit dem Wurf in
  // `originalError` an; Yogas eigene Fehler (Parse/Validierung) ohne Hülle.
  // Ausgepackt wird mit DERSELBEN Kettenregel wie im Log-Filter
  // (involvesDomainError) — driften die beiden auseinander, wird ein
  // mehrfach gehüllter DomainError maskiert UND aus dem Log gefiltert,
  // also auf beiden Seiten unsichtbar.
  const located = error instanceof GraphQLError ? error : null;
  const original = unwrapDomainError(error) ?? located?.originalError ?? error;
  if (original instanceof DomainError) {
    const options: GraphQLErrorOptions = {
      extensions: { code: 'DOMAIN_ERROR' },
    };
    // Position/Pfad der Hülle erhalten — wie zuvor, als DomainError selbst
    // ein GraphQLError war und `locatedError` sie beisteuerte.
    if (located?.nodes) options.nodes = located.nodes;
    if (located?.source) options.source = located.source;
    if (located?.positions) options.positions = located.positions;
    if (located?.path) options.path = located.path;
    return new GraphQLError(original.message, options);
  }
  return yogaMaskError(error, message, isDev);
}

/**
 * Den DomainError aus einer (beliebig tiefen) GraphQLError-Hüllenkette holen —
 * null, wenn keiner drinsteckt. Gemeinsame Unwrap-Regel für Maskierung UND
 * Log-Filter, damit beide immer dieselben Fehler als "erwartet" einstufen.
 */
function unwrapDomainError(value: unknown): DomainError | null {
  if (value instanceof DomainError) return value;
  if (value instanceof GraphQLError && value.originalError != null) {
    return unwrapDomainError(value.originalError);
  }
  return null;
}

/** DomainError selbst oder eine GraphQLError-Hülle um einen DomainError? */
function involvesDomainError(value: unknown): boolean {
  return unwrapDomainError(value) !== null;
}

/**
 * Yoga loggt jeden Fehler, den maskError durch ein NEUES Objekt ersetzt, als
 * error mit vollem Stacktrace (server.js: `if (newError !== error)
 * this.logger.error(error)`). Seit maskInternalErrors DomainErrors in frische
 * GraphQLErrors umverpackt (M3), träfe das auch sie — jedes „Nicht
 * angemeldet" eines ausgeloggten Tabs, jeder Rate-Limit-Treffer würde
 * Dauerrauschen, das echte Fehler verdeckt. DomainErrors sind aber erwartete,
 * nutzerpräsentierbare Zustände, keine Serverfehler. Dieser Logger filtert
 * genau diese error-Aufrufe heraus; alles andere (interne Fehler — die
 * SOLLEN geloggt werden, gerade weil das UI nur „Unexpected error." sieht —
 * sowie Yogas debug/info/warn) läuft unverändert über den Default-Logger.
 */
function createDomainErrorSilentLogger(): YogaLogger {
  const base = createLogger();
  return {
    debug: (...args) => base.debug(...args),
    info: (...args) => base.info(...args),
    warn: (...args) => base.warn(...args),
    error: (...args) => {
      if (args.some(involvesDomainError)) return;
      base.error(...args);
    },
  };
}

/**
 * Lehnt Cross-Site-Schreibzugriffe ab (F6). Die Authentifizierung hängt allein
 * am Ambient-Cookie; ohne diese Prüfung genügt ein HTML-Formular in einer
 * Preview, um eine Mutation im Namen des Betrachters auszulösen.
 */
function useCsrfGuard(originsFor: (request: Request) => string[]): Plugin<YogaServerContext> {
  return {
    onRequest({ request, endResponse }) {
      const allowed = originsFor(request);
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
  // EINMAL beim Aufbau aus der Config (M6) — vorher wurde die Env-Variable
  // MACVIBES_ALLOWED_ORIGINS bei jedem Request neu gelesen und geparst.
  const configuredOrigins = config.allowedOrigins;
  const originsFor = (request: Request): string[] =>
    allowedOrigins({
      host: request.headers.get('host'),
      configured: configuredOrigins,
      // Im Dev läuft das Web-UI auf einem eigenen Vite-Port und proxied
      // /graphql mit changeOrigin — diese Origin muss erlaubt sein (F5).
      // NUR bei ausdrücklich gesetztem MACVIBES_WEB_PORT (sonst null): der
      // frühere Default 5173 war ein Loch, denn in Produktion läuft dort KEIN
      // Vite, sondern der Port, den sich die erste Sandbox für ihre Preview
      // greift (templates.json: previewPort 5173). Damit vertraute die
      // Allowlist ausgerechnet dem vom Agenten kontrollierten Ursprung —
      // genau der Angriff, den CORS/CSRF verhindern sollen.
      devWebPort: config.devWebPort,
      secure: isSecureRequest(request),
    });
  return createYoga<YogaServerContext, GraphQLContext>({
    schema,
    graphqlEndpoint: '/graphql',
    landingPage: false,
    logging: createDomainErrorSilentLogger(),
    // F24: interne Meldungen werden maskiert, DomainErrors bleiben wörtlich
    // sichtbar (s. maskInternalErrors). MACVIBES_DEBUG_ERRORS=1 hebt die
    // Maskierung für die Fehlersuche auf.
    maskedErrors: config.debugErrors ? false : { maskError: maskInternalErrors },
    // F5: KEIN Default-CORS (spiegelte jede Origin mit Credentials).
    cors: (request) => ({
      // Leere Liste NIE durchreichen: Yoga spiegelte dann eine beliebige
      // Origin (2. Scan, F21). 'null' passt auf keine echte Origin.
      origin: originsFor(request).length > 0 ? originsFor(request) : ['null'],
      credentials: true,
      allowedHeaders: ['content-type'],
      methods: ['GET', 'POST', 'OPTIONS'],
    }),
    plugins: [useCookies(), useCsrfGuard(originsFor)],
    context: async ({ request, ip }) => {
      const token = await readSessionToken(request);
      const currentUser = token ? await resolveSession(db, config, token) : null;
      return {
        db,
        config,
        currentUser,
        request,
        // Session-Cookies als Fähigkeiten in den Context (B2): die Resolver
        // kennen kein http/cookies — NUR hier ist festgelegt, wie das
        // Session-Cookie an diesem Request gelesen/geschrieben wird.
        session: {
          write: (sessionToken, expiresAt) => writeSessionCookie(request, sessionToken, expiresAt),
          clear: () => clearSessionCookie(request),
          readToken: () => readSessionToken(request),
        },
        sandboxManager,
        chatService,
        clientIp: ip ?? null,
      };
    },
  });
}
