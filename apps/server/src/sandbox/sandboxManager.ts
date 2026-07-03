import type { SandboxContext, SandboxHandle, SandboxProvider, SandboxStatus } from './provider';

export interface SandboxManagerOptions {
  provider: SandboxProvider;
  /** Stopp-Verzögerung nach Verlassen der Chat-Page (R9). */
  graceMs: number;
  /** Stopp nach Agent-Inaktivität, auch bei offener Chat-Page (R9). */
  idleMs: number;
  /** Maximal gleichzeitige Sandboxes; darüber wird per LRU verdrängt (R9). */
  maxSandboxes: number;
  /** Hook vor jedem Stopp — Auto-Commit eines offenen Stands (R8/R9). */
  onBeforeStop?: (projectId: string) => Promise<void>;
  onStatusChange?: (projectId: string, status: SandboxStatus) => void;
}

type Timer = ReturnType<typeof setTimeout>;

interface SandboxEntry {
  context: SandboxContext;
  status: SandboxStatus;
  handle: SandboxHandle | null;
  lastActivityAt: number;
  graceTimer: Timer | null;
  idleTimer: Timer | null;
}

export class SandboxManager {
  private readonly entries = new Map<string, SandboxEntry>();

  constructor(private readonly options: SandboxManagerOptions) {}

  async enter(context: SandboxContext): Promise<void> {
    const existing = this.entries.get(context.projectId);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      this.clearGrace(existing);
      this.touch(existing);
      return;
    }

    const entry: SandboxEntry = {
      context,
      status: 'stopped',
      handle: null,
      lastActivityAt: Date.now(),
      graceTimer: null,
      idleTimer: null,
    };
    this.entries.set(context.projectId, entry);

    await this.evictLeastActiveIfNeeded(context.projectId);

    this.setStatus(entry, 'starting');
    try {
      entry.handle = await this.options.provider.start(context);
    } catch (error) {
      this.setStatus(entry, 'stopped');
      throw error;
    }
    this.setStatus(entry, 'running');
    this.touch(entry);
  }

  leave(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (!entry || (entry.status !== 'running' && entry.status !== 'starting')) return;
    this.clearGrace(entry);
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      void this.stop(projectId);
    }, this.options.graceMs);
  }

  noteAgentActivity(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (!entry || entry.status !== 'running') return;
    this.touch(entry);
  }

  status(projectId: string): SandboxStatus {
    return this.entries.get(projectId)?.status ?? 'stopped';
  }

  previewHostPort(projectId: string): number | null {
    const entry = this.entries.get(projectId);
    if (!entry || entry.status !== 'running') return null;
    return entry.handle?.previewHostPort ?? null;
  }

  async stop(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry || (entry.status !== 'running' && entry.status !== 'starting')) return;

    this.clearGrace(entry);
    this.clearIdle(entry);
    this.setStatus(entry, 'stopping');

    if (this.options.onBeforeStop) {
      try {
        await this.options.onBeforeStop(projectId);
      } catch (error) {
        // Auto-Commit-Fehler dürfen den Stopp nicht blockieren, aber nie
        // stillschweigend verschwinden (Konvention: keine verschluckten Fehler).
        console.error(`onBeforeStop für ${projectId} schlug fehl:`, error);
      }
    }

    try {
      await entry.handle?.stop();
    } finally {
      entry.handle = null;
      this.setStatus(entry, 'stopped');
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((projectId) => this.stop(projectId)));
  }

  private touch(entry: SandboxEntry): void {
    entry.lastActivityAt = Date.now();
    this.clearIdle(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      void this.stop(entry.context.projectId);
    }, this.options.idleMs);
  }

  private setStatus(entry: SandboxEntry, status: SandboxStatus): void {
    entry.status = status;
    this.options.onStatusChange?.(entry.context.projectId, status);
  }

  private clearGrace(entry: SandboxEntry): void {
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
  }

  private clearIdle(entry: SandboxEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private async evictLeastActiveIfNeeded(enteringProjectId: string): Promise<void> {
    const active = () =>
      [...this.entries.values()].filter(
        (e) =>
          e.context.projectId !== enteringProjectId &&
          (e.status === 'running' || e.status === 'starting'),
      );

    while (active().length >= this.options.maxSandboxes) {
      const victim = active().reduce((oldest, e) =>
        e.lastActivityAt < oldest.lastActivityAt ? e : oldest,
      );
      await this.stop(victim.context.projectId);
    }
  }
}
