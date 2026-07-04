import type { ExecProcess, ExecSpawner } from './vmRunner';

/**
 * Realer Spawner: startet einen Befehl per `msb exec` in einer laufenden
 * Sandbox. stdin wird geschlossen, stdout gestreamt (stream-json), stderr
 * geerbt (Diagnose landet im Server-Log).
 */
export const msbExecSpawner: ExecSpawner = ({ sandboxName, args, env, cwd }): ExecProcess => {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const proc = Bun.spawn(['msb', 'exec', '-w', cwd, ...envArgs, sandboxName, '--', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  return {
    stdout: proc.stdout,
    kill: () => proc.kill(),
    exited: proc.exited,
  };
};
