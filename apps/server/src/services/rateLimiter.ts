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
  /** Anzahl geführter Schlüssel — für Tests/Diagnose. */
  keyCount(): number;
  /** Summe der Schlüssellängen in Zeichen — für Tests/Diagnose. */
  keyBytes(): number;
}

/**
 * Ab dieser Länge wird ein Schlüssel zu einem Digest verdichtet (H4).
 *
 * Der Login-Resolver baut den Schlüssel aus `args.username`, und die
 * Längenprüfung von usernameSchema greift erst IN login() — also nach dem
 * Limiter. Ein unangemeldeter Angreifer bestimmt damit Inhalt und Länge des
 * Map-Schlüssels. Ein Digest hält den Speicher pro Eintrag konstant, ohne die
 * Unterscheidbarkeit der Schlüssel aufzugeben (Truncation würde verschiedene
 * Namen in einen Eimer werfen und damit fremde Konten aussperrbar machen).
 */
const MAX_KEY_CHARS = 80;

/** Harte Obergrenze für die Anzahl geführter Schlüssel (H4). */
const MAX_KEYS = 10_000;

/**
 * Beim Aufräumen wird bis hierhin verdrängt, nicht nur bis MAX_KEYS.
 *
 * Sonst räumt jeder weitere Aufruf am Limit erneut die ganze Map durch — das
 * wäre pro Login-Versuch ein Scan über 10.000 Einträge und damit selbst ein
 * CPU-Hebel für den Angreifer. Mit Luft nach unten fällt ein Scan nur noch
 * alle (MAX_KEYS - CLEANUP_TARGET) Einfügungen an.
 */
const CLEANUP_TARGET = 9_000;

function boundedKey(key: string): string {
  if (key.length <= MAX_KEY_CHARS) return key;
  return `#${Bun.hash(key).toString(36)}`;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const hits = new Map<string, number[]>();

  return {
    check(rawKey) {
      const key = boundedKey(rawKey);
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
      if (hits.size > MAX_KEYS) {
        // Erst die leergelaufenen Schlüssel — das ist der Normalfall und kostet
        // niemanden eine echte Sperre.
        for (const [k, times] of hits) {
          if (times.every((t) => t <= cutoff)) hits.delete(k);
        }
        // Reicht das nicht (viele verschiedene Namen INNERHALB des Fensters,
        // also keiner abgelaufen), in Einfügereihenfolge verdrängen — der
        // älteste Eintrag zuerst.
        for (const k of hits.keys()) {
          if (hits.size <= CLEANUP_TARGET) break;
          hits.delete(k);
        }
      }
      return true;
    },
    reset() {
      hits.clear();
    },
    keyCount() {
      return hits.size;
    },
    keyBytes() {
      let summe = 0;
      for (const k of hits.keys()) summe += k.length;
      return summe;
    },
  };
}

/** Ist das Limit per Env abgeschaltet (E2E)? */
export function rateLimitDisabled(): boolean {
  return Bun.env.MACVIBES_RATE_LIMIT_DISABLED === '1';
}
