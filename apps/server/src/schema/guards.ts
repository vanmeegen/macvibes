import { DomainError } from '../core/errors';
import type { UserRow } from '../db/schema';
import type { ProjectSessionDeps } from '../services/projectSessionService';
import { createRateLimiter, type RateLimiter } from '../services/rateLimiter';
import type { GraphQLContext } from './builder';

/**
 * Rate-Limit für die unauthentifizierte Fläche (F14): jeder Versuch kostet ein
 * argon2id-verify bzw. -hash. Zwei Schlüssel — pro IP gegen Dauerfeuer, pro
 * Username gegen verteiltes Raten auf ein einzelnes Konto.
 */
export const loginLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 20 });
export const registerLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 10 });

export function assertWithinLimit(ctx: GraphQLContext, limiter: RateLimiter, keys: string[]): void {
  // MACVIBES_RATE_LIMIT_DISABLED=1 (nur E2E) — seit M6 über die Config.
  if (ctx.config.rateLimitDisabled) return;
  for (const key of keys) {
    if (!limiter.check(key)) {
      throw new DomainError('Zu viele Versuche — bitte einige Minuten warten.');
    }
  }
}

export function requireUser(ctx: GraphQLContext): UserRow {
  if (!ctx.currentUser) {
    throw new DomainError('Nicht angemeldet');
  }
  return ctx.currentUser;
}

export function requireAdmin(ctx: GraphQLContext): UserRow {
  const user = requireUser(ctx);
  if (user.role !== 'admin') {
    throw new DomainError('Nur ein Admin darf das');
  }
  return user;
}

/** Abhängigkeiten der Projekt-Session-Use-Cases aus dem Request-Kontext. */
export function sessionDeps(ctx: GraphQLContext): ProjectSessionDeps {
  return {
    db: ctx.db,
    sandbox: ctx.sandboxManager,
    chat: ctx.chatService,
    macvibesHome: ctx.config.macvibesHome,
  };
}
