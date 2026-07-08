import type { PreviewStatus } from './provider';

export interface PreviewStatusPollerDeps {
  /** Holt den aktuellen Status (monit-API oder passiver HTTP-Probe). Darf werfen. */
  fetchStatus: () => Promise<PreviewStatus>;
  intervalMs?: number;
  onStatusChange?: (status: PreviewStatus) => void;
}

/**
 * Pollt den Preview-Status der VM im Hintergrund und hält ihn synchron
 * abfragbar (SandboxHandle.previewStatus ist sync). Ersetzt beim
 * Daemon-Transport den host-seitigen PreviewSupervisor: Restarts macht der
 * In-VM-Supervisor — hier wird nur noch GELESEN.
 */
export class PreviewStatusPoller {
  private status: PreviewStatus = 'starting';
  private everReady = false;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: PreviewStatusPollerDeps) {}

  start(): void {
    if (this.timer !== null || this.stopped) return;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setStatus('stopped');
  }

  getStatus(): PreviewStatus {
    return this.status;
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const status = await this.deps.fetchStatus();
      this.everReady = this.everReady || status === 'ready';
      this.setStatus(status);
    } catch {
      // Status-Quelle nicht erreichbar: beim Boot normal (starting),
      // nach einem ready ein Ausfall (restarting) — nie ein stiller Hänger.
      this.setStatus(this.everReady ? 'restarting' : 'starting');
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.deps.intervalMs ?? 2000);
  }

  private setStatus(status: PreviewStatus): void {
    if (this.stopped && status !== 'stopped') return;
    if (this.status === status) return;
    this.status = status;
    this.deps.onStatusChange?.(status);
  }
}
