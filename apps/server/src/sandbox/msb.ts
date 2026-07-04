import type { Subprocess } from 'bun';

export class MicrosandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrosandboxError';
  }
}

export async function runMsb(args: string[]): Promise<string> {
  let proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn(['msb', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    throw new MicrosandboxError(`msb konnte nicht gestartet werden: ${String(error)}`);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new MicrosandboxError(`msb ${args[0]} schlug fehl (${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

export interface ExecHandle {
  kill(): void;
  readonly exited: Promise<number>;
}

/**
 * Startet einen Befehl per `msb exec` in einer laufenden Sandbox (detached).
 * Für langlebige Prozesse wie den Dev-Server; stdout/stderr landen im
 * Server-Log. Rückgabe reicht für den PreviewSupervisor (kill + exited).
 */
export function msbExec(
  sandboxName: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): ExecHandle {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const proc = Bun.spawn(['msb', 'exec', '-w', cwd, ...envArgs, sandboxName, '--', ...args], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'inherit',
  });
  return { kill: () => proc.kill(), exited: proc.exited };
}

/** Ist die msb-CLI auf dem Host verfügbar? */
export async function msbAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['msb', '--version'], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
