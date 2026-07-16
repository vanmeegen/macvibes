import type { PreviewStatus } from './provider';

export interface PushedPreviewStatusOptions {
  /** Ab wann ein Daemon-Push als veraltet gilt. */
  staleMs: number;
  /** Zeitquelle (Tests). */
  now?: () => number;
}

/**
 * Host-seitiger Empfänger der preview-status-Pushes des VM-Daemons (ADR 0001).
 * Frische Pushes sind maßgeblich (monit-Detailtiefe: failed/restarting);
 * bleiben sie aus, entscheidet die HTTP-Probe auf die Preview — Monitoring
 * ist nie Single Point of Failure.
 */
export class PushedPreviewStatus {
  private last: { status: PreviewStatus; at: number } | null = null;

  constructor(private readonly options: PushedPreviewStatusOptions) {}

  receive(status: PreviewStatus): void {
    this.last = { status, at: (this.options.now ?? Date.now)() };
  }

  /**
   * fetchStatus-Funktion für den PreviewStatusPoller: frischer Push zählt;
   * ohne (oder mit veraltetem) Push entscheidet die Probe — antwortet die
   * Preview, ist sie `ready`, sonst wirft die Funktion und der Poller macht
   * daraus wie gehabt starting (vor erstem ready) bzw. restarting (danach).
   */
  fetchStatus(probe: () => Promise<boolean>): () => Promise<PreviewStatus> {
    return async () => {
      const now = (this.options.now ?? Date.now)();
      if (this.last !== null && now - this.last.at <= this.options.staleMs) {
        return this.last.status;
      }
      if (await probe()) return 'ready';
      throw new Error('Kein frischer Daemon-Status und die Preview antwortet nicht auf HTTP');
    };
  }
}
