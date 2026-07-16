import { gateReadyWithProbe, previewStatusFromMonitText } from '../../sandbox/monitStatus';
import type { PreviewStatus } from '../../sandbox/provider';

export interface PreviewStatusReporterDeps {
  /** Liest die monit-Statusseite IN der VM (localhost, kein Port-Mapping). */
  fetchMonitText: () => Promise<string>;
  /** HTTP-Probe auf den Dev-Server (localhost:<previewPort>) — Gate für ready. */
  probe: () => Promise<boolean>;
  /** Pusht den Status über die Daemon-Verbindung zum Host. */
  send: (status: PreviewStatus) => void;
  /** Poll-Intervall (Default 2000 ms). */
  intervalMs?: number;
  /** Unveränderten Status spätestens nach dieser Zeit erneut pushen (Default 5000 ms). */
  keepaliveMs?: number;
}

/**
 * Liest den Preview-Status in der VM (monit + HTTP-Probe) und pusht ihn über
 * die bestehende Daemon-Verbindung zum Host (ADR 0001). Pusht bei jedem
 * Statuswechsel sofort und unverändert als Keepalive — bei Fehlern wird
 * NICHTS gesendet, der Host fällt dann per Staleness auf seine Probe zurück.
 */
export class PreviewStatusReporter {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent: PreviewStatus | null = null;
  private lastSentAt = 0;

  constructor(private readonly deps: PreviewStatusReporterDeps) {}

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
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      const status = await gateReadyWithProbe(
        previewStatusFromMonitText(await this.deps.fetchMonitText()),
        this.deps.probe,
      );
      const keepaliveDue = Date.now() - this.lastSentAt >= (this.deps.keepaliveMs ?? 5000);
      if (status !== this.lastSent || keepaliveDue) {
        this.deps.send(status);
        this.lastSent = status;
        this.lastSentAt = Date.now();
      }
    } catch {
      // Kein verlässlicher Befund (monit weg / Dev-Server bootet): nichts
      // senden — der Host fällt per Staleness auf seine eigene Probe zurück.
    }
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, this.deps.intervalMs ?? 2000);
  }
}
