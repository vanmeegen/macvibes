/**
 * Sliding-Window-Zähler im Speicher (F14).
 *
 * Jeder unauthentifizierte `login` erzwingt ein argon2id-`verify`, `register`
 * zusätzlich ein `hash` — ohne Bremse ist das eine CPU-Senke für jeden mit
 * Netzzugriff, und Passwortraten kostet nichts. Bewusst prozesslokal: macvibes
 * läuft als ein Prozess auf einem Mac, ein verteilter Zähler wäre Ballast.
 */
export interface RateLimiterOptions {
  windowMs: number;
  /** Erlaubte Versuche pro Schlüssel im Fenster. */
  max: number;
  /** Injizierbar für Tests. */
  now?: () => number;
}

export interface RateLimiter {
  /** true = erlaubt (und gezählt), false = Limit erreicht. */
  check(key: string): boolean;
  reset(): void;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();

  return {
    check(key) {
      const current = now();
      const cutoff = current - options.windowMs;
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (recent.length >= options.max) {
        // Fenster bleibt gefüllt, aber der Versuch wird nicht mitgezählt —
        // sonst verlängerte jeder abgewiesene Versuch die Sperre endlos.
        hits.set(key, recent);
        return false;
      }
      recent.push(current);
      hits.set(key, recent);
      // Leergelaufene Schlüssel entfernen, damit die Map nicht wächst.
      if (hits.size > 1000) {
        for (const [k, times] of hits) {
          if (times.every((t) => t <= cutoff)) hits.delete(k);
        }
      }
      return true;
    },
    reset() {
      hits.clear();
    },
  };
}

/** Ist das Limit per Env abgeschaltet (E2E)? */
export function rateLimitDisabled(): boolean {
  return Bun.env.MACVIBES_RATE_LIMIT_DISABLED === '1';
}
