import { ensureWorkspace } from '../services/workspaceService';
import { baselineExists, baselineSnapshotName } from './baselineService';
import { runMsb } from './msb';
import { findFreePort } from './portService';
import type { SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export { MicrosandboxError, msbAvailable } from './msb';

export interface MicrosandboxProviderConfig {
  macvibesHome: string;
  bareRepoPath: string;
  /** OCI-Image für die Sandbox-VMs (Default: oven/bun). */
  image: string;
  cpus: number;
  memoryMib: number;
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

    // Baseline-Fork (B5b): node_modules kommt vorinstalliert aus dem Snapshot
    // und wird in den gemounteten Workspace gelinkt — kein Install zur Laufzeit.
    const useBaseline = await baselineExists(context.templateDir);
    const bootstrap = useBaseline
      ? `[ -e node_modules ] || ln -s /baseline/work/node_modules node_modules; exec ${context.devCommand}`
      : `if [ -f package.json ] && [ ! -d node_modules ]; then bun install --silent; fi; exec ${context.devCommand}`;
    const source = useBaseline
      ? ['--snapshot', baselineSnapshotName(context.templateDir)]
      : [this.config.image];

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
      ...source,
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
