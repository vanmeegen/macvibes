import { describe, expect, test } from 'bun:test';
import {
  SHUTDOWN_GRACE_SECONDS,
  SHUTDOWN_STEP_TIMEOUTS_MS,
  SHUTDOWN_STEPS_TOTAL_MS,
} from '../shutdownTimings';

/**
 * Die Invariante, die der Live-Befund 2026-08 erzwungen hat: Frist pro Schritt
 * (ShutdownSequence) und Gesamt-Grace des Skripts standen unabhängig auf 45 s,
 * ein einziger Hänger fraß das ganze Budget und schnitt den Auto-Commit ab.
 * Diese Tests bewachen das Verhältnis maschinell, damit es nicht wieder
 * auseinanderläuft.
 */
describe('Shutdown-Fristen-Budget', () => {
  test('Summe aller Schritt-Fristen ist kleiner als die Skript-Grace', () => {
    // Sonst kann das Skript nie mehr als einen langsamen Schritt beobachten,
    // bevor es hart killt — und schneidet die restlichen Schritte ab.
    expect(SHUTDOWN_STEPS_TOTAL_MS).toBeLessThan(SHUTDOWN_GRACE_SECONDS * 1000);
  });

  test('der Auto-Commit-Schritt ist nicht knapper als die übrigen', () => {
    // Er ist der Grund für die geordnete Abschaltung (haertung-2026-07,
    // Abschnitt 1) und darf beim Staffeln nicht am kürzesten wegkommen.
    const autoCommit = SHUTDOWN_STEP_TIMEOUTS_MS['Sandboxes (inkl. Auto-Commit)'];
    for (const [name, ms] of Object.entries(SHUTDOWN_STEP_TIMEOUTS_MS)) {
      if (name === 'Sandboxes (inkl. Auto-Commit)') continue;
      expect(autoCommit).toBeGreaterThanOrEqual(ms);
    }
  });
});
