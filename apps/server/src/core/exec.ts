/**
 * Plattformneutrales Ausführen von Shell-Kommando-Strings (Basisschicht).
 *
 * `spawnShellCommand` interpretiert das Kommando mit `bun exec` — Buns
 * eingebauter Cross-Platform-Shell — statt `sh -c`: identisches Verhalten
 * auf macOS und Windows, ohne Plattform-Weiche. `kill()` beendet den ganzen
 * Prozessbaum (tree-kill kapselt `kill` vs. `taskkill /T`); der frühere
 * `exec ${cmd}`-Trick (damit das Signal den echten Server statt der sh
 * trifft) wird damit überflüssig.
 */
import { openSync } from 'node:fs';
import treeKill from 'tree-kill';

export interface ShellCommandOptions {
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** stdout+stderr im Anhänge-Modus in diese Datei (ersetzt `>> log 2>&1`). */
  logFile?: string | undefined;
  /** Ohne logFile: was mit stdout/stderr geschieht (Default: ignore). */
  stdout?: 'ignore' | 'inherit' | undefined;
  stderr?: 'ignore' | 'inherit' | undefined;
}

/** Gestarteter Kommando-Prozess; strukturkompatibel zu SupervisedProcess. */
export interface ShellProcess {
  readonly pid: number;
  /** Beendet den gesamten Prozessbaum (nicht nur den Shell-Wrapper). */
  kill(): void;
  readonly exited: Promise<number>;
}

export function spawnShellCommand(
  command: string,
  options: ShellCommandOptions = {},
): ShellProcess {
  // Append-Handle statt Shell-Redirect; ein Handle für stdout UND stderr
  // wäre unter Windows doppelt geschlossen worden — deshalb zwei.
  const out = options.logFile ? openSync(options.logFile, 'a') : (options.stdout ?? 'ignore');
  const err = options.logFile ? openSync(options.logFile, 'a') : (options.stderr ?? 'ignore');
  const proc = Bun.spawn([process.execPath, 'exec', command], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env as Record<string, string> } : {}),
    stdout: out,
    stderr: err,
  });
  return {
    pid: proc.pid,
    kill: () => {
      if (proc.exitCode === null) killTree(proc.pid);
    },
    exited: proc.exited.then((code) => code ?? 0),
  };
}

/**
 * Beendet einen Prozess samt aller Nachfahren. Fehler (z. B. Prozess schon
 * weg) werden gemeldet, nicht geworfen — kill ist best effort, die Aufrufer
 * warten ohnehin auf `exited`.
 */
export function killTree(pid: number): void {
  treeKill(pid, 'SIGTERM', (error) => {
    if (error) console.warn(`Prozessbaum ${pid} konnte nicht beendet werden:`, error.message);
  });
}
