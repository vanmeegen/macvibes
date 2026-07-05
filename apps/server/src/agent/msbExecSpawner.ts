import type { ExecProcess, ExecSpawner } from './vmRunner';

/**
 * Tötet alle laufenden claude-Prozesse im Gast. Zwei Einsatzorte:
 * - VOR jedem Start (gleiche exec-Session, race-frei): Orphans abgebrochener
 *   Turns laufen sonst weiter und microsandbox vermischt die Streams
 *   gleichzeitiger exec-Sessions — neue Turns wirken dann „stumm".
 * - Beim Abort: `proc.kill()` beendet nur die Host-Seite von `msb exec`,
 *   der Gast-Prozess liefe (und verbrauchte Tokens) sonst weiter.
 */
const KILL_ORPHANS =
  'for d in /proc/[0-9]*; do case "$(readlink "$d/exe" 2>/dev/null)" in *claude*) kill -9 "${d##*/}" 2>/dev/null;; esac; done';

/**
 * Realer Spawner: startet einen Befehl per `msb exec` in einer laufenden
 * Sandbox. stdin wird geschlossen, stdout gestreamt (stream-json), stderr
 * getrennt erfasst (Diagnose landet im Chat).
 *
 * Die eigentlichen Args laufen als Positional-Parameter durch `sh -c '…; exec "$@"'`
 * — kein Quoting-Risiko, und die Orphan-Bereinigung passiert garantiert davor.
 */
export const msbExecSpawner: ExecSpawner = ({ sandboxName, args, env, cwd }): ExecProcess => {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const proc = Bun.spawn(
    [
      'msb',
      'exec',
      '-w',
      cwd,
      ...envArgs,
      sandboxName,
      '--',
      'sh',
      '-c',
      `${KILL_ORPHANS}; exec "$@"`,
      'sh',
      ...args,
    ],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    kill: () => {
      proc.kill();
      // Gast-Seite ebenfalls beenden — sonst arbeitet der Agent unsichtbar weiter.
      const cleanup = Bun.spawn(['msb', 'exec', sandboxName, '--', 'sh', '-c', KILL_ORPHANS], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      cleanup.exited.catch((error) => {
        console.error(`Gast-Cleanup für ${sandboxName} fehlgeschlagen:`, error);
      });
    },
    exited: proc.exited,
  };
};
