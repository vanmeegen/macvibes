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
      if (proc.exitCode === null) void killTreeOnceSettled(proc);
    },
    exited: proc.exited.then((code) => code ?? 0),
  };
}

/** Höchstens so lange wartet kill() darauf, dass der Wrapper sein Kind gestartet hat. */
const CHILD_SPAWN_GRACE_MS = 1_000;

/**
 * Beendet den Prozessbaum — aber erst, wenn der Wrapper (`bun exec`) sein Kind
 * gestartet hat. tree-kill sammelt die Nachfahren EINMAL ein und beendet dann
 * alle; ein kill() unmittelbar nach dem Spawn fand deshalb noch kein Kind,
 * beendete nur den Wrapper, und das kurz darauf gestartete Kind lief als Waise
 * weiter (verwaiste Dev-Server nach einem Stop direkt nach dem Start).
 *
 * Die Wartezeit ist gedeckelt: ein Kommando aus reinen Shell-Builtins bekommt
 * nie ein Kind und wird nach der Frist trotzdem beendet.
 */
async function killTreeOnceSettled(proc: { pid: number; exitCode: number | null }): Promise<void> {
  const deadline = Date.now() + CHILD_SPAWN_GRACE_MS;
  while (proc.exitCode === null && Date.now() < deadline && !(await hasChildProcess(proc.pid))) {
    await Bun.sleep(20);
  }
  if (proc.exitCode === null) killTree(proc.pid);
}

/**
 * Hat der Prozess schon ein Kind? Feature-Detection statt Plattform-Weiche:
 * ohne `pgrep` (Windows) gilt „ja" — dann wird wie bisher sofort beendet.
 */
async function hasChildProcess(pid: number): Promise<boolean> {
  if (Bun.which('pgrep') === null) return true;
  try {
    const exitCode = await Bun.spawn(['pgrep', '-P', String(pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited;
    return exitCode === 0;
  } catch (error) {
    console.warn(`Kindprozesse von ${pid} nicht ermittelbar:`, error);
    return true;
  }
}

/**
 * Beendet einen Prozess samt aller Nachfahren. Fehler (z. B. Prozess schon
 * weg) werden gemeldet, nicht geworfen — kill ist best effort, die Aufrufer
 * warten ohnehin auf `exited`.
 */
function killTree(pid: number): void {
  treeKill(pid, 'SIGTERM', (error) => {
    if (error) console.warn(`Prozessbaum ${pid} konnte nicht beendet werden:`, error.message);
  });
}
