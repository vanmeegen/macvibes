import { makeAutoObservable } from 'mobx';

export type PreviewStatus = 'unavailable' | 'waiting' | 'ready';

/**
 * Zustand der Live-Preview (R7): pollt den Dev-Server der Sandbox, bis er
 * erreichbar ist, und stellt erst dann die iframe-URL bereit — statt eines
 * Browser-Fehlerbildes gibt es einen klaren „startet…"-Zustand.
 */
export class PreviewModel {
  status: PreviewStatus = 'unavailable';
  url: string | null = null;
  /** Poll-Handle — bewusst nicht observable. */
  pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly pollIntervalMs: number = 1000) {
    makeAutoObservable(this, { pollTimer: false }, { autoBind: true });
  }

  start(host: string, port: number): void {
    const url = `http://${host}:${port}/`;
    if (this.url === url && this.status !== 'unavailable') return;

    this.stopPolling();
    this.url = url;
    this.status = 'waiting';
    void this.check(url);
    this.pollTimer = setInterval(() => {
      void this.check(url);
    }, this.pollIntervalMs);
  }

  reset(): void {
    this.stopPolling();
    this.status = 'unavailable';
    this.url = null;
  }

  private async check(url: string): Promise<void> {
    try {
      // no-cors: es zählt nur die Erreichbarkeit, nicht die Antwort.
      await fetch(url, { mode: 'no-cors' });
      if (this.url !== url) return;
      this.setReady();
    } catch {
      // Dev-Server (noch) nicht erreichbar — weiter pollen.
    }
  }

  private setReady(): void {
    this.status = 'ready';
    this.stopPolling();
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
