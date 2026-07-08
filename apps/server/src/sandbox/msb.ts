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

export interface WaitForExecReadyOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Exec-Probe (injizierbar für Tests). Wirft, solange die VM nicht bereit ist. */
  probe?: (name: string) => Promise<unknown>;
}

/**
 * Wartet, bis `msb exec` in der Sandbox funktioniert (Gast-Agent-Endpunkt
 * bereit). Verhindert die "no agent endpoint found"-Race beim ersten Prompt
 * und "exec session ended without exit event" direkt nach `msb run -d`.
 */
export async function waitForExecReady(
  name: string,
  options: WaitForExecReadyOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const probe = options.probe ?? ((n: string) => runMsb(['exec', n, '--', 'true']));

  const start = Date.now();
  let lastError: unknown = null;
  for (;;) {
    try {
      await probe(name);
      return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - start >= timeoutMs) {
      throw new MicrosandboxError(`Sandbox ${name} wurde nicht exec-bereit: ${String(lastError)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
