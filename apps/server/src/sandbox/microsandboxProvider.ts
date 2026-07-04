import { ensureWorkspace } from '../services/workspaceService';
import { baselineExists, baselineSnapshotName } from './baselineService';
import { httpProbe } from './httpProbe';
import { msbExec, runMsb } from './msb';
import { PreviewSupervisor } from './previewSupervisor';
import { findFreePort } from './portService';
import type { PreviewStatus, SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export { MicrosandboxError, msbAvailable } from './msb';

export interface MicrosandboxProviderConfig {
  macvibesHome: string;
  bareRepoPath: string;
  /** OCI-Image für die Sandbox-VMs (Default: oven/bun). */
  image: string;
  cpus: number;
  memoryMib: number;
}

/** Sandbox-Name eines Projekts — vom Provider und vom VM-Runner genutzt. */
export function microsandboxSandboxName(projectId: string): string {
  return `macvibes-${projectId}`;
}

/** Arbeitsverzeichnis in der VM — Mountpunkt des Projekt-Workspace. */
const GUEST_WORKDIR = '/work';

/**
 * Echter Sandbox-Provider auf microsandbox-MicroVMs (libkrun).
 *
 * Architektur (Watchdog-fähig): Die VM läuft als **stabiler Halter**
 * (`sleep infinity` als PID 1) und überlebt so einen Dev-Server-Crash — der
 * Agent (Claude Code, per `msb exec`) verliert seine Umgebung nicht. Der
 * Preview-/Dev-Server wird von einem **host-seitigen `PreviewSupervisor`**
 * per `msb exec` gestartet, überwacht und bei Ausfall neu gestartet.
 *
 * Schnittstelle zum Template (template-agnostisch): ausschließlich
 * `devCommand` + `previewPort` + PORT-Env aus templates.json.
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
    const name = microsandboxSandboxName(context.projectId);

    // Baseline-Fork (B5b): node_modules kommt vorinstalliert aus dem Snapshot
    // und wird in den gemounteten Workspace gelinkt — kein Install zur Laufzeit.
    const useBaseline = await baselineExists(context.templateDir);
    const bootstrap = useBaseline
      ? `[ -e node_modules ] || ln -s /baseline/work/node_modules node_modules`
      : `if [ -f package.json ] && [ ! -d node_modules ]; then bun install --silent; fi`;
    const source = useBaseline
      ? ['--snapshot', baselineSnapshotName(context.templateDir)]
      : [this.config.image];

    // VM als stabiler Halter starten (Dev-Server läuft NICHT als PID 1).
    await runMsb([
      'run',
      '-d',
      '--no-tty',
      '--replace',
      '-q',
      '--name',
      name,
      '-v',
      `${workspaceDir}:${GUEST_WORKDIR}`,
      '-w',
      GUEST_WORKDIR,
      // 0.0.0.0: Preview ist im LAN erreichbar (R7/NFR).
      '-p',
      `0.0.0.0:${hostPort}:${context.previewPort}`,
      // Egress: öffentliches Internet (bun/npm) + Host-Gateway für den
      // Credential-Proxy (host.microsandbox.internal, B5c). Private Netze
      // sonst gesperrt — der Agent kommt nicht ins LAN.
      '--net-rule',
      'allow@public,allow@172.16.0.0/12',
      '-c',
      String(this.config.cpus),
      '-m',
      `${this.config.memoryMib}M`,
      ...source,
      '--',
      'sh',
      '-c',
      `${bootstrap}; exec sleep infinity`,
    ]);

    // Watchdog: Dev-Server per `msb exec` starten + überwachen (host-seitig).
    const supervisor = new PreviewSupervisor({
      spawn: () =>
        msbExec(
          name,
          ['sh', '-c', context.devCommand],
          { PORT: String(context.previewPort) },
          GUEST_WORKDIR,
        ),
      probe: () => httpProbe(`http://localhost:${hostPort}/`),
      onStatusChange: (status) => console.log(`Preview ${context.projectId}: ${status}`),
    });
    supervisor.start();

    return {
      previewHostPort: hostPort,
      previewStatus: (): PreviewStatus => supervisor.getStatus(),
      stop: async () => {
        await supervisor.stop();
        try {
          await runMsb(['stop', name]);
        } catch (error) {
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
