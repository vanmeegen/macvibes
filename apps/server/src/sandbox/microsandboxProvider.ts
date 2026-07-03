import type { Subprocess } from 'bun';
import { ensureWorkspace } from '../services/workspaceService';
import { findFreePort } from './portService';
import type { SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export interface MicrosandboxProviderConfig {
  macvibesHome: string;
  bareRepoPath: string;
  /** OCI-Image für die Sandbox-VMs (Default: oven/bun). */
  image: string;
  cpus: number;
  memoryMib: number;
}

export class MicrosandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrosandboxError';
  }
}

async function runMsb(args: string[]): Promise<string> {
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

function sandboxNameFor(projectId: string): string {
  return `macvibes-${projectId}`;
}

/**
 * Echter Sandbox-Provider auf microsandbox-MicroVMs (libkrun):
 * Projekt-Volume wird in die VM gemountet, das devCommand läuft mit
 * PORT-Env in der VM, der Preview-Port wird auf einen freien Host-Port
 * gemappt (LAN-tauglich, R7). Isolation: kein Host-Zugriff außer dem
 * gemounteten Workspace (R9/NFR). Fehlende node_modules installiert die
 * VM vor dem Start selbst (entfällt mit den Baseline-Snapshots, B5b).
 */
export class MicrosandboxSandboxProvider implements SandboxProvider {
  constructor(private readonly config: MicrosandboxProviderConfig) {}

  async start(context: SandboxContext): Promise<SandboxHandle> {
    const workspaceDir = await ensureWorkspace({
      macvibesHome: this.config.macvibesHome,
      bareRepoPath: this.config.bareRepoPath,
      projectId: context.projectId,
      branchName: context.branchName,
    });

    const hostPort = await findFreePort(context.previewPort);
    const name = sandboxNameFor(context.projectId);
    const bootstrap = `if [ -f package.json ] && [ ! -d node_modules ]; then bun install --silent; fi; exec ${context.devCommand}`;

    await runMsb([
      'run',
      '-d',
      '--no-tty',
      '--replace',
      '-q',
      '--name',
      name,
      '-v',
      `${workspaceDir}:/work`,
      '-w',
      '/work',
      // 0.0.0.0: Preview ist im LAN erreichbar (R7/NFR).
      '-p',
      `0.0.0.0:${hostPort}:${context.previewPort}`,
      '-c',
      String(this.config.cpus),
      '-m',
      `${this.config.memoryMib}M`,
      '-e',
      `PORT=${context.previewPort}`,
      this.config.image,
      '--',
      'sh',
      '-c',
      bootstrap,
    ]);

    return {
      previewHostPort: hostPort,
      stop: async () => {
        try {
          await runMsb(['stop', name]);
        } catch (error) {
          // Bereits gestoppt ist in Ordnung — alles andere weiterreichen.
          console.error(`msb stop ${name}:`, error);
        }
        try {
          await runMsb(['rm', name]);
        } catch (error) {
          console.error(`msb rm ${name}:`, error);
        }
      },
    };
  }
}
