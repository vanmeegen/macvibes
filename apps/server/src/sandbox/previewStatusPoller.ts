import type { PreviewStatus } from './provider';

export interface PreviewStatusPollerDeps {
  /** Holt den aktuellen Status (monit-API oder passiver HTTP-Probe). Darf werfen. */
  fetchStatus: () => Promise<PreviewStatus>;
  /**
   * Abstand zwischen zwei Abfragen, NACHDEM die Preview einmal bereit war
   * (Default 2000 ms) — dann geht es nur noch darum, einen Ausfall zu bemerken.
   */
  intervalMs?: number;
  /**
   * Abstand SOLANGE die Preview noch nie bereit war (Default 250 ms).
   *
   * Gemessen: die VM ist nach ~200 ms da, der Dev-Server antwortet nach ~560 ms
   * — mit einem festen 2000-ms-Takt meldeten wir `ready` aber erst nach ~3150 ms.
   * Rund 2,5 Sekunden davon waren reine Erkennungslatenz, also Warten auf unsere
   * eigene nächste Frage. Beim Start wird deshalb eng gepollt, danach wieder
   * ruhig — die schnelle Phase dauert nur die erste Sekunde.
   */
  startupIntervalMs?: number;
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

  /**
   * Statuswechsel von außen — für den Daemon-Push (ADR 0001), der den Zustand
   * SOFORT meldet, statt bis zum nächsten Poll-Zyklus zu warten. Ohne das war
   * der Push nur eine Datenquelle, die gesampelt wurde: gemessen ~850 ms
   * Verzögerung zwischen „Dev-Server antwortet" und „wir melden ready".
   * Das Pollen bleibt als unabhängiger Wächter bestehen — bleibt der Daemon
   * stumm, erkennt die HTTP-Probe den Zustand trotzdem.
   */
  notify(status: PreviewStatus): void {
    if (this.stopped) return;
    this.everReady = this.everReady || status === 'ready';
    this.setStatus(status);
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
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.poll();
      },
      this.everReady ? (this.deps.intervalMs ?? 2000) : (this.deps.startupIntervalMs ?? 250),
    );
  }

  private setStatus(status: PreviewStatus): void {
    if (this.stopped && status !== 'stopped') return;
    if (this.status === status) return;
    this.status = status;
    this.deps.onStatusChange?.(status);
  }
}
