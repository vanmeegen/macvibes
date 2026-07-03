import { ensureWorkspace } from '../services/workspaceService';
import type { SandboxContext, SandboxHandle, SandboxProvider } from './provider';

export interface ProcessProviderConfig {
  macvibesHome: string;
  bareRepoPath: string;
}

/**
 * Prozess-basierter Provider: arbeitet direkt auf dem Host (kein VM-Isolat).
 * Dient als Entwicklungs-/Test-Backend; der microsandbox-Provider (B5)
 * implementiert dasselbe Interface mit echten MicroVMs.
 */
export class ProcessSandboxProvider implements SandboxProvider {
  constructor(private readonly config: ProcessProviderConfig) {}

  async start(context: SandboxContext): Promise<SandboxHandle> {
    await ensureWorkspace({
      macvibesHome: this.config.macvibesHome,
      bareRepoPath: this.config.bareRepoPath,
      projectId: context.projectId,
      branchName: context.branchName,
    });
    // Preview-Server (devCommand) folgt in B3.
    return {
      previewUrl: null,
      stop: async () => {},
    };
  }
}
