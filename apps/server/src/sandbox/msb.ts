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

/** Ist die msb-CLI auf dem Host verfügbar? */
export async function msbAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(['msb', '--version'], { stdout: 'ignore', stderr: 'ignore' });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
