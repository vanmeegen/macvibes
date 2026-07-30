/**
 * Zugriff auf microsandbox über das offizielle SDK statt über die `msb`-CLI.
 *
 * Warum der Umstieg: Die CLI-Anbindung (`runMsb`) kannte nur einen Fehlertyp —
 * „irgendein msb-Aufruf ist fehlgeschlagen". Aufrufer mussten daraus raten, was
 * los war, und rieten falsch: `snapshotExists` deutete JEDEN Fehler als
 * „existiert nicht", sodass eine defekte msb-Installation als fehlende Baseline
 * erschien („bitte `bun run baselines` ausführen"). Dieselbe Klasse von
 * stillem Fehlschlag steckte im Shutdown-Skript.
 *
 * Das SDK typisiert Fehler — allerdings UNEINHEITLICH (Stand 0.6.8): Sandboxes
 * werfen `SandboxNotFoundError`, Snapshots dagegen ein generisches `Error` mit
 * der Kennung `[SnapshotNotFound]` im Text. Beides wird hier gekapselt, damit
 * der Rest der Anwendung nur noch eindeutige Begriffe sieht.
 */
import { Sandbox, SandboxNotFoundError, Snapshot } from 'microsandbox';

/** Fehlerbegriff der Sandbox-Schicht — ersetzt den CLI-weiten MicrosandboxError. */
export class SandboxRuntimeError extends Error {
  constructor(
    message: string,
    readonly ursache?: unknown,
  ) {
    super(message);
    this.name = 'SandboxRuntimeError';
  }
}

function fehlertext(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/** Ist das der Fehler „diese Sandbox gibt es nicht"? */
export function istSandboxNichtGefunden(error: unknown): boolean {
  return error instanceof SandboxNotFoundError;
}

/**
 * Ist das der Fehler „diesen Snapshot gibt es nicht"?
 *
 * Anders als bei Sandboxes gibt es dafür (noch) keine eigene Fehlerklasse; das
 * SDK liefert ein generisches `Error` mit `code = 'GenericFailure'` und der
 * Kennung im Text. Die Prüfung hängt damit an einer Zeichenkette — bewusst eng
 * gefasst, damit ein anderer Fehler nicht versehentlich als „fehlt" durchgeht.
 * Sobald das SDK eine `SnapshotNotFoundError`-Klasse mitbringt, gehört das hier
 * ersetzt.
 */
export function istSnapshotNichtGefunden(error: unknown): boolean {
  return fehlertext(error).includes('[SnapshotNotFound]');
}

/** Ist die microsandbox-Laufzeit benutzbar? */
export async function msbAvailable(): Promise<boolean> {
  try {
    await Sandbox.list();
    return true;
  } catch {
    return false;
  }
}

/**
 * Existiert ein Snapshot mit diesem Namen?
 *
 * Nur ein echtes „nicht gefunden" ergibt `false`. Jeder andere Fehler (defekte
 * Installation, Schema-Konflikt, fehlende Rechte) fliegt weiter — sonst
 * verwandelt sich ein kaputtes Werkzeug in eine irreführende Fachmeldung.
 */
export async function snapshotExists(name: string): Promise<boolean> {
  try {
    await Snapshot.get(name);
    return true;
  } catch (error) {
    if (istSnapshotNichtGefunden(error)) return false;
    throw new SandboxRuntimeError(
      `Snapshot „${name}" konnte nicht geprüft werden: ${fehlertext(error)}`,
      error,
    );
  }
}
