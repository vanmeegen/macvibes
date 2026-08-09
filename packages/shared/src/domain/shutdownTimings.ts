/**
 * Fristen-Budget für das geordnete Herunterfahren — EINE Quelle für zwei Orte,
 * die sonst auseinanderlaufen und es in der Vergangenheit taten:
 *
 *   - die Frist PRO SCHRITT der ShutdownSequence (`apps/server/src/shutdownSequence.ts`,
 *     in `index.ts` pro Schritt aus diesem Budget gesetzt), und
 *   - die Gesamt-Grace des Shutdown-Skripts (`scripts/shutdown.ts`, `GRACE_SECONDS`).
 *
 * Live-Befund 2026-08: Beide standen unabhängig auf 45 s. Ein einziger
 * hängender Schritt (das Preview-Gateway) fraß damit das komplette
 * Skript-Budget, und die noch ausstehenden Schritte — u. a. der Auto-Commit —
 * wurden per `kill -9` abgeschnitten. Genau diesen Auto-Commit soll die
 * geordnete Abschaltung aber retten (`docs/haertung-2026-07.md`, Abschnitt 1).
 *
 * INVARIANTE (maschinell bewacht in `__tests__/shutdownTimings.test.ts`):
 * Die Summe aller Schritt-Fristen ist KLEINER als die Grace des Skripts. Nur so
 * kann das Skript mehr als einen langsamen Schritt beobachten, bevor es hart
 * killt — statt schon am ersten Hänger sein ganzes Budget zu verlieren.
 *
 * Warum in `packages/shared`: Das Top-Level-`scripts/` darf bewusst NICHT aus
 * `apps/server/src/**` importieren (Composition-Root-Trennung, Architektur-Gate
 * in `eslint.config.js`). Gemeinsamer Code lebt deshalb hier.
 */

/**
 * Frist pro Abschaltschritt in ms, je Schritt einzeln. Die Schlüssel sind die
 * Namen, unter denen `index.ts` die Schritte registriert. Bewusst gestaffelt:
 *
 *   - schnelle, unkritische Schritte (Router-, Mirror-, Gateway-Stopp) knapp,
 *   - der Auto-Commit-Schritt (Sandboxes stoppen samt `git commit` pro VM)
 *     großzügig — er ist der Grund für die geordnete Abschaltung und darf NICHT
 *     knapper werden als die anderen.
 */
export const SHUTDOWN_STEP_TIMEOUTS_MS = {
  'lokaler Modell-Router': 10_000,
  'GitHub-Mirror': 10_000,
  'Preview-Gateway': 10_000,
  'Sandboxes (inkl. Auto-Commit)': 45_000,
} as const;

/** Name eines registrierten Abschaltschritts (Schlüssel des Budgets oben). */
export type ShutdownStepName = keyof typeof SHUTDOWN_STEP_TIMEOUTS_MS;

/** Summe aller Schritt-Fristen in ms. */
export const SHUTDOWN_STEPS_TOTAL_MS: number = Object.values(SHUTDOWN_STEP_TIMEOUTS_MS).reduce(
  (summe, ms) => summe + ms,
  0,
);

/**
 * Gesamt-Grace des Shutdown-Skripts in Sekunden. Größer als die Summe aller
 * Schritt-Fristen (plus Puffer für Signal-/Prozessabbau), damit die Invariante
 * mit Reserve hält und das Skript mehrere langsame Schritte überdauern kann,
 * bevor es hart beendet.
 */
export const SHUTDOWN_GRACE_SECONDS: number = Math.ceil(SHUTDOWN_STEPS_TOTAL_MS / 1000) + 15;
