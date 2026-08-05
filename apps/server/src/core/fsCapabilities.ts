import { chmodSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Feature-Detection statt Plattform-Weiche (windows-portierung-plan.md, P5):
 * Kann das Dateisystem unter `dir` POSIX-Modes wirklich durchsetzen? Geprüft
 * durch Probieren (Datei anlegen, chmod 0600, stat) — NTFS meldet
 * unabhängig vom chmod 0o666 und liefert damit `false`. Dann sind
 * 0600/0700-Schutzmaßnahmen (F25/F26) wirkungslos, und Warnungen, die auf
 * Mode-Bits aufbauen, wären irreführend.
 */
export function supportsPosixModes(dir: string): boolean {
  const probe = join(dir, `.macvibes-mode-probe-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, '');
    chmodSync(probe, 0o600);
    return (statSync(probe).mode & 0o077) === 0;
  } catch {
    // Nicht beschreibbar/nicht vorhanden → Modes hier jedenfalls nicht
    // durchsetzbar; das `false` IST die Antwort, kein verschluckter Fehler.
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
}
