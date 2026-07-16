import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorkspace } from '../services/workspaceService';
import { httpProbe } from './httpProbe';
import { PreviewSupervisor, type SupervisedProcess } from './previewSupervisor';
import { findFreePort } from './portService';
import type { PreviewStatus, SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export interface ProcessProviderConfig {
  macvibesHome: string;
  bareRepoPath: string;
}

/**
 * Prozess-basierter Provider: arbeitet direkt auf dem Host (kein VM-Isolat).
 * Dient als Entwicklungs-/Test-Backend; der microsandbox-Provider (B5)
 * implementiert dasselbe Interface mit echten MicroVMs.
 *
 * Preview-Kontrakt (R7, template-agnostisch): das devCommand aus
 * templates.json wird mit gesetzter PORT-Env gestartet; die Plattform kennt
 * keinerlei Template-Interna. Der PreviewSupervisor startet den Dev-Server
 * bei Absturz neu — gleiches Verhalten wie in der MicroVM.
 */
export class ProcessSandboxProvider implements SandboxProvider {
  constructor(private readonly config: ProcessProviderConfig) {}

  async start(context: SandboxContext): Promise<SandboxHandle> {
    const workspaceDir = await ensureWorkspace({
      macvibesHome: this.config.macvibesHome,
      bareRepoPath: this.config.bareRepoPath,
      projectId: context.projectId,
      branchName: context.branchName,
    });

    const port = await findFreePort(context.previewPort);
    // Delta-Install bei jedem Start (ADR 0002, Parität zur MicroVM): bei
    // vollständigem node_modules ein No-Op, sonst heilt er fehlende Pakete
    // aus bun.lock (z. B. ein bun add einer früheren Session).
    if (existsSync(join(workspaceDir, 'package.json'))) {
      await Bun.spawn(['bun', 'install', '--silent'], { cwd: workspaceDir }).exited;
    }

    const spawn = (): SupervisedProcess => {
      const proc = Bun.spawn(['sh', '-c', `exec ${context.devCommand}`], {
        cwd: workspaceDir,
        env: { ...process.env, PORT: String(port) },
        stdout: 'ignore',
        stderr: 'inherit',
      });
      return {
        kill: () => {
          if (proc.exitCode === null) proc.kill('SIGTERM');
        },
        exited: proc.exited.then((code) => code ?? 0),
      };
    };

    const supervisor = new PreviewSupervisor({
      spawn,
      probe: () => httpProbe(`http://localhost:${port}/`),
    });
    supervisor.start();

    return {
      previewHostPort: port,
      previewStatus: (): PreviewStatus => supervisor.getStatus(),
      stop: async () => {
        await supervisor.stop();
      },
    };
  }
}
