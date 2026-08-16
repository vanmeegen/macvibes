import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_SANDBOXES,
  FIXED_SHUTDOWN_STEP_TIMEOUTS_MS,
  sandboxShutdownBudgetMs,
  shutdownGraceSeconds,
  shutdownStepsTotalMs,
} from '../shutdownTimings';

/**
 * Die Invariante, die der Live-Befund 2026-08 erzwungen hat: Frist pro Schritt
 * (ShutdownSequence) und Gesamt-Grace des Skripts standen unabhängig auf 45 s,
 * ein einziger Hänger fraß das ganze Budget und schnitt den Auto-Commit ab.
 * Diese Tests bewachen das Verhältnis maschinell, damit es nicht wieder
 * auseinanderläuft.
 *
 * N10 aus dem Zustandsmaschinen-Audit: Das Sandbox-Budget war FLACH (45 s),
 * obwohl stopAll() bis zu maxSandboxes VMs mit je einem seriellen
 * git add/commit/push auf demselben Host stoppt — bei vollem Haus wurden
 * laufende Auto-Commits vom Schritt-Timeout (skip) plus process.exit gekappt,
 * ein geordneter Neustart hinterließ Orphans wie ein Crash. Deshalb skaliert
 * das Budget jetzt mit maxSandboxes, und die Skript-Grace kommt aus derselben
 * Formel — die Invariante gilt für JEDE Flottengröße.
 */
describe('Shutdown-Fristen-Budget (skaliert mit maxSandboxes, N10)', () => {
  for (const n of [1, 2, DEFAULT_MAX_SANDBOXES, 16, 64]) {
    test(`Invariante hält für maxSandboxes=${n}: Schrittsumme < Skript-Grace`, () => {
      // Sonst kann das Skript nie mehr als einen langsamen Schritt beobachten,
      // bevor es hart killt — und schneidet die restlichen Schritte ab.
      expect(shutdownStepsTotalMs(n)).toBeLessThan(shutdownGraceSeconds(n) * 1000);
    });

    test(`Sandbox-Budget ist für maxSandboxes=${n} nicht knapper als jeder fixe Schritt`, () => {
      // Der Auto-Commit-Schritt ist der Grund für die geordnete Abschaltung
      // (haertung-2026-07, Abschnitt 1) und darf nie am kürzesten wegkommen.
      for (const ms of Object.values(FIXED_SHUTDOWN_STEP_TIMEOUTS_MS)) {
        expect(sandboxShutdownBudgetMs(n)).toBeGreaterThanOrEqual(ms);
      }
    });
  }

  test('Default-Flotte (8 VMs) schrumpft nicht unter die bisherigen 45 s', () => {
    // Verhaltensschutz: mit dem Default ändert sich am Ist-Zustand NICHTS —
    // erst ein abweichendes MACVIBES_MAX_SANDBOXES bewegt die Budgets.
    expect(DEFAULT_MAX_SANDBOXES).toBe(8);
    expect(sandboxShutdownBudgetMs(DEFAULT_MAX_SANDBOXES)).toBeGreaterThanOrEqual(45_000);
    expect(shutdownGraceSeconds(DEFAULT_MAX_SANDBOXES)).toBe(90);
  });

  test('das Budget wächst pro VM (seriell teure git-Pushes)', () => {
    expect(sandboxShutdownBudgetMs(16)).toBeGreaterThan(sandboxShutdownBudgetMs(8));
    // Unsinnige Werte fallen auf mindestens eine VM zurück.
    expect(sandboxShutdownBudgetMs(0)).toBe(sandboxShutdownBudgetMs(1));
  });
});
