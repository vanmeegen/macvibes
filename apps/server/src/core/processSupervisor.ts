import type { PreviewStatus } from '../preview/status';

/**
 * Lebenszyklus-Status eines überwachten Prozesses — bewusst dasselbe
 * Vokabular wie der Preview-Status (preview/status), damit Provider den
 * Supervisor-Status unverändert als PreviewStatus melden können.
 */
export type ProcessStatus = PreviewStatus;

/** Ein überwachter Prozess, reduziert auf das Nötige (Test-Naht). */
export interface SupervisedProcess {
  kill(): void;
  readonly exited: Promise<number>;
}

export interface ProcessSupervisorDeps {
  /** Startet den überwachten Prozess (z. B. Dev-Server oder Modell-Router). */
  spawn: () => SupervisedProcess;
  /** Health-Check: antwortet der Prozess (typisch: HTTP auf seinem Port)? */
  probe: () => Promise<boolean>;
  onStatusChange?: (status: ProcessStatus) => void;
  /** Poll-Intervall für den Health-Check. */
  probeIntervalMs?: number;
  /** Wie lange auf den initialen „ready"-Zustand gewartet wird, bevor neu gestartet wird. */
  startTimeoutMs?: number;
  /** Aufeinanderfolgende fehlgeschlagene Probes, bevor ein laufender Server als tot gilt. */
  unhealthyThreshold?: number;
  /** Crash-Loop-Schutz: max. Neustarts innerhalb des Fensters, dann „failed". */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** Wartezeit vor einem Neustart. */
  backoffMs?: number;
}

const DEFAULTS = {
  probeIntervalMs: 1000,
  startTimeoutMs: 60_000,
  unhealthyThreshold: 3,
  maxRestarts: 5,
  restartWindowMs: 60_000,
  backoffMs: 1000,
};

/**
 * Generischer host-seitiger Prozess-Watchdog: startet einen Prozess über
 * `spawn`, überwacht ihn per Health-Check (`probe`) und startet ihn bei
 * Ausfall (Crash oder Hänger) mit Backoff neu. Crash-Loops enden in
 * „failed" statt in endlosen Neustarts.
 *
 * Verwender: der ProcessSandboxProvider für den Preview-Dev-Server (R7,
 * template-agnostisch — einzige Schnittstelle ist `spawn`/`probe`) und der
 * localRouterService für den LiteLLM-Shim. Der Supervisor kennt keinen
 * davon — er ist bewusst prozess-agnostisch (Basisschicht).
 */
export class ProcessSupervisor {
  private readonly opts: Required<
    Omit<ProcessSupervisorDeps, 'spawn' | 'probe' | 'onStatusChange'>
  >;
  private status: ProcessStatus = 'stopped';
  private current: SupervisedProcess | null = null;
  private stopped = false;
  private monitorGen = 0;
  private restartTimes: number[] = [];

  constructor(private readonly deps: ProcessSupervisorDeps) {
    this.opts = {
      probeIntervalMs: deps.probeIntervalMs ?? DEFAULTS.probeIntervalMs,
      startTimeoutMs: deps.startTimeoutMs ?? DEFAULTS.startTimeoutMs,
      unhealthyThreshold: deps.unhealthyThreshold ?? DEFAULTS.unhealthyThreshold,
      maxRestarts: deps.maxRestarts ?? DEFAULTS.maxRestarts,
      restartWindowMs: deps.restartWindowMs ?? DEFAULTS.restartWindowMs,
      backoffMs: deps.backoffMs ?? DEFAULTS.backoffMs,
    };
  }

  getStatus(): ProcessStatus {
    return this.status;
  }

  /** Startet den Prozess und den Überwachungs-Loop. */
  start(): void {
    if (this.status !== 'stopped') return;
    this.stopped = false;
    // Fehler hier dürfen nie als unhandled rejection den Server killen.
    this.runCycle().catch((error) => {
      console.error('Prozess-Supervisor-Zyklus fehlgeschlagen:', error);
      this.setStatus('failed');
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.monitorGen += 1; // laufende Loops invalidieren
    const proc = this.current;
    this.current = null;
    if (proc) {
      proc.kill();
      await proc.exited.catch(() => {});
    }
    this.setStatus('stopped');
  }

  private setStatus(status: ProcessStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.deps.onStatusChange?.(status);
  }

  /** Ein Lebenszyklus des überwachten Prozesses: starten, ready-werden, überwachen. */
  private async runCycle(): Promise<void> {
    if (this.stopped) return;

    if (!this.registerAttempt()) {
      this.setStatus('failed');
      return;
    }

    const gen = ++this.monitorGen;
    // spawn kann synchron werfen (z. B. ENOENT, wenn der Workspace nach einer
    // Projekt-Löschung weg ist und die Crash-Recovery neu starten will). Das
    // darf NIE als unbehandelte Exception aus dem fire-and-forget runCycle()
    // entkommen — sonst reißt es den ganzen Server mit (Live-Absturz im E2E).
    let proc: SupervisedProcess;
    try {
      proc = this.deps.spawn();
    } catch (error) {
      console.error('Überwachter Prozess konnte nicht gestartet werden:', error);
      this.setStatus('failed');
      return;
    }
    this.current = proc;
    // Erster Start → "starting"; Neustarts hat restart() schon auf
    // "restarting" gesetzt, dieser Zustand bleibt bis der Server wieder ready ist.
    if (this.status !== 'restarting') {
      this.setStatus('starting');
    }

    let processExited = false;
    void proc.exited.then(() => {
      processExited = true;
    });

    // Startphase: geduldig auf "ready" warten. Der Port darf ruhig noch
    // schweigen (der Prozess bootet) — NICHT neu starten, solange die
    // Startphase läuft. Nur ein Prozess-Crash beendet sie vorzeitig.
    const deadline = Date.now() + this.opts.startTimeoutMs;
    let ready = false;
    while (!this.stopped && gen === this.monitorGen && Date.now() < deadline) {
      if (processExited) break;
      if (await this.safeProbe()) {
        ready = true;
        break;
      }
      await Bun.sleep(this.opts.probeIntervalMs);
    }

    if (this.stopped || gen !== this.monitorGen) return;

    if (!ready) {
      // Startphase erfolglos (Hänger oder Crash beim Start) → Neustart.
      await this.restart(gen, proc);
      return;
    }

    this.setStatus('ready');
    await this.monitor(gen, proc, () => processExited);
  }

  /** Laufphase: Health-Check + Crash-Erkennung, bis Ausfall oder Stop. */
  private async monitor(
    gen: number,
    proc: SupervisedProcess,
    hasExited: () => boolean,
  ): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.stopped && gen === this.monitorGen) {
      await Bun.sleep(this.opts.probeIntervalMs);
      if (this.stopped || gen !== this.monitorGen) return;

      if (hasExited()) {
        await this.restart(gen, proc);
        return;
      }
      const healthy = await this.safeProbe();
      if (healthy) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        if (consecutiveFailures >= this.opts.unhealthyThreshold) {
          await this.restart(gen, proc);
          return;
        }
      }
    }
  }

  private async restart(gen: number, proc: SupervisedProcess): Promise<void> {
    if (this.stopped || gen !== this.monitorGen) return;
    this.setStatus('restarting');
    proc.kill();
    await proc.exited.catch(() => {});
    if (this.stopped || gen !== this.monitorGen) return;
    await Bun.sleep(this.opts.backoffMs);
    if (this.stopped || gen !== this.monitorGen) return;
    // Fehler hier dürfen nie als unhandled rejection den Server killen.
    this.runCycle().catch((error) => {
      console.error('Prozess-Supervisor-Zyklus fehlgeschlagen:', error);
      this.setStatus('failed');
    });
  }

  /** Crash-Loop-Schutz: max. Neustarts im gleitenden Fenster. */
  private registerAttempt(): boolean {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < this.opts.restartWindowMs);
    // Der erste Start zählt nicht als "Neustart".
    if (this.restartTimes.length >= this.opts.maxRestarts + 1) {
      return false;
    }
    this.restartTimes.push(now);
    return true;
  }

  private async safeProbe(): Promise<boolean> {
    try {
      return await this.deps.probe();
    } catch {
      return false;
    }
  }
}
