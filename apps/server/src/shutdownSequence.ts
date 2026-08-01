/**
 * Geordnetes Herunterfahren des Servers.
 *
 * Vorher registrierte `index.ts` ZWEI unabhängige SIGINT/SIGTERM-Handler: einer
 * stoppte den lokalen Modell-Router und rief danach `process.exit(0)`, der
 * andere stoppte die Sandboxes inklusive Auto-Commit. Der erste gewann
 * praktisch immer — `localRouterReady` ist im Normalfall längst aufgelöst und
 * `stop()` ein No-op, also feuerte `exit(0)` nach zwei Microtasks, während
 * `stopAll()` noch auf `git commit` wartete. Ergebnis: Bei jedem Herunterfahren
 * mit laufender VM ging der letzte Turn verloren.
 *
 * Deshalb hier EINE Sequenz mit EINEM Handler-Paar: Schritte werden
 * registriert, während der Server hochfährt, und laufen beim Signal in
 * umgekehrter Reihenfolge — zuletzt Gestartetes wird zuerst gestoppt. Beendet
 * wird der Prozess erst, wenn alle Schritte durch sind.
 */

export type ShutdownStepFn = () => Promise<void> | void;

export interface ShutdownSequenceOptions {
  /** Test-Naht: sonst `process.exit`. */
  exit?: ((code: number) => void) | undefined;
  log?: ((message: string) => void) | undefined;
  /**
   * Frist pro Schritt in ms. Ein Schritt, der länger braucht, wird
   * übersprungen, damit ein einzelner Hänger den ganzen Abgang nicht blockiert.
   * Default 45 s — dieselbe Grosszügigkeit wie `MACVIBES_SHUTDOWN_GRACE` in
   * shutdown.sh, damit ein echter Auto-Commit Zeit hat.
   */
  stepTimeoutMs?: number | undefined;
}

/** Default-Frist pro Abschaltschritt. */
const DEFAULT_STEP_TIMEOUT_MS = 45_000;

interface ShutdownStep {
  name: string;
  run: ShutdownStepFn;
}

export class ShutdownSequence {
  private readonly steps: ShutdownStep[] = [];
  private readonly exit: (code: number) => void;
  private readonly log: (message: string) => void;
  private readonly stepTimeoutMs: number;
  /** Der laufende Abgang — ein zweites Signal wartet ihn ab, statt ihn zu doppeln. */
  private running: Promise<void> | null = null;

  constructor(options: ShutdownSequenceOptions = {}) {
    this.exit = options.exit ?? ((code: number) => process.exit(code));
    this.log = options.log ?? ((message: string) => console.log(message));
    this.stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  /** Registriert einen Abschaltschritt. Später registriert = früher gestoppt. */
  register(name: string, run: ShutdownStepFn): void {
    this.steps.push({ name, run });
  }

  /**
   * Läuft alle Schritte ab und beendet den Prozess.
   *
   * Beim ERSTEN Signal startet der geordnete Abgang. Ein ZWEITES Signal
   * während dieser noch läuft (der Nutzer drückt erneut Ctrl-C, weil etwas
   * hängt) beendet den Prozess SOFORT mit Code 1 — der Notausstieg, falls ein
   * Schritt trotz Frist nicht durchkommt.
   */
  async handle(signal: string): Promise<void> {
    if (this.running !== null) {
      this.log(`${signal} erneut empfangen — sofortiges Beenden.`);
      this.exit(1);
      return;
    }
    this.running = this.runAll(signal);
    return this.running;
  }

  private async runAll(signal: string): Promise<void> {
    this.log(`${signal} empfangen — fahre geordnet herunter…`);
    // Rückwärts: zuletzt Gestartetes zuerst stoppen. Damit laufen die
    // Sandboxes (samt Auto-Commit) vor dem Modell-Router, der sie bedient hat.
    for (const step of [...this.steps].reverse()) {
      await this.runStep(step);
    }
    this.exit(0);
  }

  /**
   * Führt einen Schritt mit Frist aus. Weder ein Fehler noch ein Hänger darf
   * die übrigen Schritte oder das Prozessende verhindern — sonst kostete ein
   * einzelner klemmender Schritt (git auf einer index.lock, ein nicht
   * zurückkehrendes `msb stop`) genau den Auto-Commit, den die Sequenz retten
   * soll. Verschluckt wird trotzdem nichts: Fehler und Fristüberschreitung
   * werden gemeldet.
   */
  private runStep(step: ShutdownStep): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.log(`Abschaltschritt „${step.name}" hängt (>${this.stepTimeoutMs}ms) — übersprungen.`);
        resolve();
      }, this.stepTimeoutMs);
      // async-Wrapper fängt auch synchrone Würfe; der Reject-Zweig fängt einen
      // späten Fehler nach dem Timeout ab, sodass keine unhandled rejection
      // entsteht.
      void (async () => step.run())().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          this.log(`Abschaltschritt „${step.name}" schlug fehl: ${String(error)}`);
          resolve();
        },
      );
    });
  }
}
