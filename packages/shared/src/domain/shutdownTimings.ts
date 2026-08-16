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
 * N10 (Zustandsmaschinen-Audit): Das Sandbox-Budget war FLACH (45 s), obwohl
 * `stopAll()` bis zu maxSandboxes VMs stoppt und `onBeforeStop` pro VM ein
 * serielles `git add/commit/push` auf demselben Host macht — bei vollem Haus
 * (8 VMs ≈ 5,6 s/VM inkl. Push) kappte der Schritt-Timeout (skip + exit)
 * laufende Auto-Commits, ein geordneter Neustart hinterließ Orphans wie ein
 * Crash. Deshalb ist das Sandbox-Budget jetzt eine FUNKTION von maxSandboxes,
 * und die Skript-Grace kommt aus derselben Formel. Mit dem Default (8 VMs)
 * sind die Werte byteidentisch zu vorher: 45 s Budget, 90 s Grace.
 *
 * Warum in `packages/shared`: Das Top-Level-`scripts/` darf bewusst NICHT aus
 * `apps/server/src/**` importieren (Composition-Root-Trennung, Architektur-Gate
 * in `eslint.config.js`). Gemeinsamer Code lebt deshalb hier.
 */

/** Default für MACVIBES_MAX_SANDBOXES — von config.ts und scripts/ geteilt. */
export const DEFAULT_MAX_SANDBOXES = 8;

/**
 * Frist pro Abschaltschritt in ms für die schnellen, unkritischen Schritte
 * (Router-, Mirror-, Gateway-Stopp) — bewusst knapp. Die Schlüssel sind die
 * Namen, unter denen `index.ts` die Schritte registriert. Der Sandbox-Schritt
 * fehlt hier absichtlich: sein Budget skaliert mit der Flottengröße
 * (`sandboxShutdownBudgetMs`).
 */
export const FIXED_SHUTDOWN_STEP_TIMEOUTS_MS = {
  'lokaler Modell-Router': 10_000,
  'GitHub-Mirror': 10_000,
  'Preview-Gateway': 10_000,
} as const;

/** Name eines registrierten Abschaltschritts. */
export type ShutdownStepName =
  keyof typeof FIXED_SHUTDOWN_STEP_TIMEOUTS_MS | 'Sandboxes (inkl. Auto-Commit)';

/** Fixkosten des stopAll selbst (Signal-/Prozessabbau, VM-Stopps parallel). */
const SANDBOX_SHUTDOWN_BASE_MS = 5_000;
/** Auto-Commit inkl. `git push`, seriell PRO VM auf demselben Host. */
const SANDBOX_SHUTDOWN_PER_VM_MS = 5_000;

/**
 * Budget des Sandbox-Schritts (`stopAll()` inkl. Auto-Commit) in ms — linear
 * in der Flottengröße, denn die git-Arbeit ist host-seitig seriell teuer.
 * Unsinnige Werte (0, negativ) fallen auf eine VM zurück.
 */
export function sandboxShutdownBudgetMs(maxSandboxes: number): number {
  return SANDBOX_SHUTDOWN_BASE_MS + SANDBOX_SHUTDOWN_PER_VM_MS * Math.max(1, maxSandboxes);
}

/** Summe aller Schritt-Fristen in ms für eine Flotte von maxSandboxes VMs. */
export function shutdownStepsTotalMs(maxSandboxes: number): number {
  const fix = Object.values(FIXED_SHUTDOWN_STEP_TIMEOUTS_MS).reduce((summe, ms) => summe + ms, 0);
  return fix + sandboxShutdownBudgetMs(maxSandboxes);
}

/**
 * Gesamt-Grace des Shutdown-Skripts in Sekunden. Größer als die Summe aller
 * Schritt-Fristen (plus Puffer für Signal-/Prozessabbau), damit die Invariante
 * mit Reserve hält und das Skript mehrere langsame Schritte überdauern kann,
 * bevor es hart beendet.
 */
export function shutdownGraceSeconds(maxSandboxes: number): number {
  return Math.ceil(shutdownStepsTotalMs(maxSandboxes) / 1000) + 15;
}
