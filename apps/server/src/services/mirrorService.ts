import { runGit } from './gitService';

export type MirrorResult = 'pushed' | 'no-changes' | 'skipped' | 'error';

export interface MirrorConfig {
  bareRepoPath: string;
  /** GitHub-Remote-URL (mit Token im Host-Env, nie in der VM). Null = deaktiviert. */
  remoteUrl: string | null;
}

export interface MirrorLogger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * Spiegelt das lokale Bare-Repo nach GitHub (PRD Phase C, R8). Läuft auf dem
 * Host; das Token steckt in der Remote-URL und erreicht nie eine Sandbox.
 * Fehler werden geloggt, blockieren aber das lokale Arbeiten nicht.
 */
export async function mirrorToGitHub(
  config: MirrorConfig,
  logger: MirrorLogger = console,
): Promise<MirrorResult> {
  if (config.remoteUrl === null) {
    return 'skipped';
  }
  try {
    // Nur pushen, wenn es lokale Refs gibt (frisches Repo hat keine).
    const refs = await runGit(['for-each-ref', 'refs/heads'], config.bareRepoPath);
    if (refs.trim().length === 0) {
      return 'no-changes';
    }
    // --mirror hält GitHub exakt deckungsgleich (auch gelöschte Branches).
    const output = await runGit(['push', '--mirror', config.remoteUrl], config.bareRepoPath);
    // git schreibt "Everything up-to-date" nach stderr; runGit liefert stdout —
    // ein leerer stdout heißt in der Praxis: nichts Neues übertragen.
    logger.info(`GitHub-Mirror: ${output.trim() || 'aktuell'}`);
    return 'pushed';
  } catch (error) {
    logger.error(`GitHub-Mirror fehlgeschlagen: ${String(error)}`);
    return 'error';
  }
}

export interface MirrorScheduler {
  stop(): void;
  /** Sofort einmal spiegeln (für Tests / manuellen Trigger). */
  runOnce(): Promise<MirrorResult>;
}

/**
 * Startet den periodischen Mirror. Deaktiviert (No-op), wenn keine Remote-URL
 * konfiguriert ist — die Plattform funktioniert vollständig ohne GitHub.
 */
export function startMirrorScheduler(
  config: MirrorConfig,
  intervalMs: number,
  logger: MirrorLogger = console,
): MirrorScheduler {
  const runOnce = () => mirrorToGitHub(config, logger);

  if (config.remoteUrl === null) {
    return { stop: () => {}, runOnce };
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runOnce();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    runOnce,
  };
}
