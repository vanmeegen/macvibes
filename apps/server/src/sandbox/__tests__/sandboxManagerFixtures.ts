import type { PreviewStatus } from '../../preview/status';
import type { SandboxContext, SandboxHandle, SandboxProvider } from '../provider';
import { SandboxManager } from '../sandboxManager';

/**
 * Gemeinsame Vorrichtungen der SandboxManager-Tests (nach Themen in mehrere
 * Dateien geteilt: lifecycle, viewers, limits, races).
 */

export function ctx(projectId: string): SandboxContext {
  return {
    projectId,
    branchName: `marco/${projectId}`,
    workspaceDir: `/tmp/fake/${projectId}`,
    templateDir: 'pwa',
    devCommand: 'bun run dev',
    previewPort: 5173,
  };
}

export class FakeProvider implements SandboxProvider {
  startCalls: string[] = [];
  stopCalls: string[] = [];
  /** Settable pro Projekt (Default „ready") — für die M2-Heilungstests. */
  readonly previewStatusVon = new Map<string, PreviewStatus>();

  async start(context: SandboxContext): Promise<SandboxHandle> {
    this.startCalls.push(context.projectId);
    return {
      previewHostPort: 9999,
      previewStatus: () => this.previewStatusVon.get(context.projectId) ?? 'ready',
      stop: async () => {
        this.stopCalls.push(context.projectId);
      },
    };
  }
}

export interface Setup {
  provider: FakeProvider;
  manager: SandboxManager;
  statusLog: string[];
  beforeStopLog: string[];
}

export function setup(
  overrides: {
    graceMs?: number;
    idleMs?: number;
    maxSandboxes?: number;
    isBusy?: (projectId: string) => boolean;
    healCooldownMs?: number;
  } = {},
): Setup {
  const provider = new FakeProvider();
  const statusLog: string[] = [];
  const beforeStopLog: string[] = [];
  const manager = new SandboxManager({
    provider,
    graceMs: overrides.graceMs ?? 40,
    idleMs: overrides.idleMs ?? 10_000,
    maxSandboxes: overrides.maxSandboxes ?? 8,
    ...(overrides.isBusy !== undefined ? { isBusy: overrides.isBusy } : {}),
    ...(overrides.healCooldownMs !== undefined ? { healCooldownMs: overrides.healCooldownMs } : {}),
    onBeforeStop: async (projectId) => {
      beforeStopLog.push(projectId);
    },
    onStatusChange: (projectId, status) => {
      statusLog.push(`${projectId}:${status}`);
    },
  });
  return { provider, manager, statusLog, beforeStopLog };
}

/** Provider, dessen Start an einem Gate haengt, bis man ihn freigibt. */
export function torProvider() {
  const tore = new Map<string, () => void>();
  const gestoppt: string[] = [];
  const provider: SandboxProvider = {
    async start(context: SandboxContext): Promise<SandboxHandle> {
      await new Promise<void>((resolve) => tore.set(context.projectId, resolve));
      return {
        previewHostPort: 1,
        previewStatus: () => 'ready' as const,
        stop: async () => {
          gestoppt.push(context.projectId);
        },
      };
    },
  };
  return {
    provider,
    gestoppt,
    freigeben: (projectId: string) => tore.get(projectId)?.(),
    warteAufTor: async (projectId: string) => {
      for (let i = 0; i < 200 && !tore.has(projectId); i += 1) await Bun.sleep(2);
    },
  };
}
