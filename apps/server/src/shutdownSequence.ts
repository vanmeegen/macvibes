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
   * Default-Frist pro Schritt in ms — greift nur für Schritte, die bei
   * `register()` KEINE eigene Frist mitbekommen. Ein Schritt, der länger
   * braucht, wird übersprungen, damit ein einzelner Hänger den ganzen Abgang
   * nicht blockiert.
   *
   * WICHTIG (Live-Befund 2026-08): Die Fristen stehen in einem festen
   * Verhältnis zur Gesamt-Grace des Shutdown-Skripts (`scripts/shutdown.ts`) —
   * die Summe aller Schritt-Fristen muss KLEINER sein als diese Grace, sonst
   * frisst ein einziger Hänger das ganze Skript-Budget und schneidet den
   * Auto-Commit ab. Die tatsächlich genutzten Fristen kommen darum aus EINER
   * Quelle: `SHUTDOWN_STEP_TIMEOUTS_MS` in `@macvibes/shared` (dort auch die
   * maschinell bewachte Invariante). `index.ts` setzt sie pro Schritt.
   */
  stepTimeoutMs?: number | undefined;
}

/**
 * Default-Frist pro Abschaltschritt, wenn `register()` keine eigene bekommt und
 * die Optionen keine setzen. Bewusst knapp gehalten — die echten, gestaffelten
 * Fristen kommen aus `@macvibes/shared` und werden pro Schritt gesetzt; dieser
 * Wert ist nur ein sicherer Rückfall, der keinen Abgang lange blockiert.
 */
const DEFAULT_STEP_TIMEOUT_MS = 10_000;

interface ShutdownStep {
  name: string;
  run: ShutdownStepFn;
  /** Frist dieses Schritts in ms — eigene aus `register()` oder der Default. */
  timeoutMs: number;
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

  /**
   * Registriert einen Abschaltschritt. Später registriert = früher gestoppt.
   * `timeoutMs` setzt die Frist genau für diesen Schritt (sonst der Default) —
   * so bekommt der Auto-Commit bewusst mehr Zeit als die schnellen Schritte,
   * ohne deren Frist aufzublähen.
   */
  register(name: string, run: ShutdownStepFn, timeoutMs?: number): void {
    this.steps.push({ name, run, timeoutMs: timeoutMs ?? this.stepTimeoutMs });
  }

  /**
   * Läuft alle Schritte ab und beendet den Prozess.
   *
   * Ein ZWEITES Signal wartet bewusst den laufenden Abgang ab, statt sofort zu
   * beenden. Ein Notausstieg (hartes exit beim zweiten Ctrl-C) würde einen
   * gerade laufenden Auto-Commit mitten abschneiden — und genau der ist bei
   * einem Release, während noch jemand in einer Sandbox arbeitet, der wichtige
   * Fall. Gegen echte Hänger schützt die Frist PRO SCHRITT (`stepTimeoutMs`):
   * ein klemmender Schritt wird übersprungen, der Prozess endet trotzdem.
   */
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
        this.log(`Abschaltschritt „${step.name}" hängt (>${step.timeoutMs}ms) — übersprungen.`);
        resolve();
      }, step.timeoutMs);
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
