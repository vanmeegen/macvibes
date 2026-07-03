import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorkspace } from '../services/workspaceService';
import { findFreePort } from './portService';
import type { SandboxContext, SandboxHandle, SandboxProvider } from './provider';

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
 * keinerlei Template-Interna. Fehlen die Dependencies im Volume, läuft
 * vorher `bun install` (in der MicroVM übernimmt das der Baseline-Snapshot).
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
    const needsInstall =
      existsSync(join(workspaceDir, 'package.json')) &&
      !existsSync(join(workspaceDir, 'node_modules'));
    const command = needsInstall
      ? `bun install --silent && exec ${context.devCommand}`
      : `exec ${context.devCommand}`;

    const proc = Bun.spawn(['sh', '-c', command], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        PORT: String(port),
      },
      stdout: 'ignore',
      stderr: 'inherit',
    });

    return {
      previewHostPort: port,
      stop: async () => {
        if (proc.exitCode === null) {
          proc.kill('SIGTERM');
          const exited = await Promise.race([proc.exited, Bun.sleep(3000).then(() => null)]);
          if (exited === null) {
            proc.kill('SIGKILL');
            await proc.exited;
          }
        }
      },
    };
  }
}
