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
}

interface ShutdownStep {
  name: string;
  run: ShutdownStepFn;
}

export class ShutdownSequence {
  private readonly steps: ShutdownStep[] = [];
  private readonly exit: (code: number) => void;
  private readonly log: (message: string) => void;
  /** Der laufende Abgang — ein zweites Signal wartet ihn ab, statt ihn zu doppeln. */
  private running: Promise<void> | null = null;

  constructor(options: ShutdownSequenceOptions = {}) {
    this.exit = options.exit ?? ((code: number) => process.exit(code));
    this.log = options.log ?? ((message: string) => console.log(message));
  }

  /** Registriert einen Abschaltschritt. Später registriert = früher gestoppt. */
  register(name: string, run: ShutdownStepFn): void {
    this.steps.push({ name, run });
  }

  /** Läuft alle Schritte ab und beendet den Prozess. Mehrfachaufruf ist folgenlos. */
  async handle(signal: string): Promise<void> {
    if (this.running !== null) return this.running;
    this.running = this.runAll(signal);
    return this.running;
  }

  private async runAll(signal: string): Promise<void> {
    this.log(`${signal} empfangen — fahre geordnet herunter…`);
    // Rückwärts: zuletzt Gestartetes zuerst stoppen. Damit laufen die
    // Sandboxes (samt Auto-Commit) vor dem Modell-Router, der sie bedient hat.
    for (const step of [...this.steps].reverse()) {
      try {
        await step.run();
      } catch (error) {
        // Ein fehlgeschlagener Schritt darf die übrigen nicht verhindern —
        // sonst kostet ein hängender Router den Auto-Commit. Verschlucken
        // gilt trotzdem nicht (Konvention): der Fehler wird gemeldet.
        this.log(`Abschaltschritt „${step.name}" schlug fehl: ${String(error)}`);
      }
    }
    this.exit(0);
  }
}
