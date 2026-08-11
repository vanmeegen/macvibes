import type { VmTokenRegistry } from './core/vmTokens';
import type { LocalRouterHandle } from './services/localRouterService';

/**
 * Dev-Hot-Reload-Aufräumen für `bun --hot` (nur Dev — in Produktion No-op).
 *
 * `bun --hot` führt das Entry-Modul bei JEDER Quelldatei-Änderung ERNEUT aus,
 * im selben Prozess. Die Listener und Timer der vorigen Ausführung bleiben
 * dabei bestehen: `Bun.serve` tauscht --hot zwar in-place (empirisch geprüft,
 * Bun 1.3.14), `Bun.listen` aber NICHT — der Egress-Proxy starb beim zweiten
 * Lauf mit EADDRINUSE, danach war der Server kaputt (Live-Befund 2026-07-29:
 * vier Abstürze in Folge, die Gateway-Verbindung des Agent-Daemons weg, ein
 * laufender Agent-Turn lief in den 180-s-Idle-Timeout). Ausserdem summierten
 * sich pro Reload SIGINT/SIGTERM-Handler, das GitHub-Mirror-Intervall und die
 * Sandbox-Timer auf.
 *
 * Mechanik: `import.meta.hot` ist unter `bun --hot` (1.3.14) empirisch
 * **undefined** — der dispose/accept-Weg scheidet also aus. Stattdessen das
 * versionsunabhängige Muster: Jede Ausführung registriert ihre Abräum-Schritte
 * unter einem prozessweiten Symbol auf `globalThis`; die NÄCHSTE Ausführung
 * findet sie dort und schliesst alles, BEVOR sie selbst neu bindet.
 *
 * Das Register wird SOFORT beim Start installiert und die Schritte werden
 * inkrementell eingetragen (direkt nach dem Entstehen jeder Ressource) — nicht
 * erst am Modulende. Sonst hinterliesse eine Ausführung, die MITTEN im
 * Hochlauf scheitert (z. B. ein Tippfehler in der gerade editierten Datei,
 * nachdem der Egress-Proxy schon gebunden hat), ihre Listener unauffindbar,
 * und jeder weitere Reload stürbe dauerhaft mit EADDRINUSE.
 *
 * Bewusst NICHT über die ShutdownSequence: die stoppt Sandboxes samt
 * Auto-Commit — beim Reload sollen laufende MicroVMs aber weiterleben und nur
 * die Host-Listener erneuert werden. Die ShutdownSequence bleibt unangetastet;
 * das alte Signal-Handler-Paar wird beim Reload lediglich ausgetragen, damit
 * immer genau EIN Paar (das der jüngsten Ausführung) registriert ist.
 */

/**
 * Ressourcen, die ein Reload NICHT schliesst, sondern an die nächste
 * Ausführung ÜBERGIBT, weil laufende Prozesse von ihnen abhängen.
 */
export interface HotReloadHandoff {
  /**
   * Token-Registry der laufenden VMs: die Daemons verbinden sich nach dem
   * Reload mit ihrem ALTEN Token neu — eine frische (leere) Registry würde
   * jede laufende VM dauerhaft aus Gateway, Egress- und Credential-Proxy
   * aussperren.
   */
  vmTokens: VmTokenRegistry | null;
  /**
   * Selbst gestarteter lokaler Modell-Router (LiteLLM-Shim): er soll Reloads
   * überleben (Kaltstart dauert Minuten). Ohne Übergabe stufte die nächste
   * Ausführung ihn als „extern" ein und ihr Shutdown-Schritt wäre ein No-op —
   * `bun run shutdown` liesse den selbst gestarteten Shim dann als Waise zurück.
   */
  localRouter: Promise<LocalRouterHandle> | null;
}

export type HotCleanupFn = () => void | Promise<void>;

export interface HotReloadHandle {
  /** Vom Vorgänger Übernommenes — leer beim Erststart und in Produktion. */
  inherited: HotReloadHandoff;
  /**
   * Trägt einen Abräum-Schritt ein — SOFORT nach dem Entstehen der Ressource
   * aufrufen (s. o.). Läuft beim nächsten Reload in umgekehrter Reihenfolge
   * (zuletzt Gebundenes zuerst geschlossen). Ohne `--hot` ein No-op.
   */
  addCleanup(name: string, dispose: HotCleanupFn): void;
  /**
   * Übergabe-Slots für die nächste Ausführung — nach dem Erzeugen der
   * jeweiligen Ressource befüllen. Ohne `--hot` schreibt das in ein
   * Wegwerf-Objekt, das nirgends gehalten wird.
   */
  handOver: HotReloadHandoff;
}

interface HotReloadStep {
  name: string;
  dispose: HotCleanupFn;
}

interface HotReloadRegistry {
  steps: HotReloadStep[];
  handOver: HotReloadHandoff;
}

/**
 * `Symbol.for` (nicht `Symbol()`): der Schlüssel muss über die erneute
 * Ausführung dieses Moduls hinweg identisch bleiben — ein frisches Symbol pro
 * Ausführung fände das Register des Vorgängers nie.
 */
const REGISTRY_KEY = Symbol.for('macvibes.devHotReload');

type Scope = { [REGISTRY_KEY]?: HotReloadRegistry };

/**
 * Frist pro Abräum-Schritt. Normal settelt alles in Millisekunden
 * (`stop(true)` erzwingt das Schliessen); die Frist schützt nur davor, dass
 * ein pathologisch hängender Schritt den Reload endlos blockiert.
 */
const DEFAULT_STEP_TIMEOUT_MS = 3_000;

export interface HotReloadOptions {
  /** Test-Naht: sonst `globalThis`. */
  scope?: object;
  /** Test-Naht: sonst `process.execArgv` (enthält unter `bun --hot` das Flag). */
  execArgv?: readonly string[];
  log?: (message: string) => void;
  stepTimeoutMs?: number;
}

function emptyHandoff(): HotReloadHandoff {
  return { vmTokens: null, localRouter: null };
}

/** Läuft dieser Prozess unter `bun --hot`? Empirisch: das Flag steht in execArgv. */
function isHotMode(execArgv: readonly string[]): boolean {
  return execArgv.includes('--hot');
}

/**
 * Führt einen Abräum-Schritt mit Frist aus. Weder Fehler noch Hänger dürfen
 * die übrigen Schritte verhindern — sonst bliebe genau der Listener gebunden,
 * dessentwegen der Reload vorher starb. Gemeldet wird trotzdem beides.
 */
async function runStep(
  step: HotReloadStep,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log(`Hot-Reload: Abräum-Schritt „${step.name}" hängt (>${timeoutMs}ms) — übersprungen.`);
      resolve();
    }, timeoutMs);
    // async-Wrapper fängt auch synchrone Würfe (wie ShutdownSequence.runStep).
    void (async () => step.dispose())().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        log(`Hot-Reload: Abräum-Schritt „${step.name}" schlug fehl: ${String(error)}`);
        resolve();
      },
    );
  });
}

/**
 * Muss als ERSTES in `index.ts` laufen, vor jedem Binden: räumt die Ressourcen
 * der vorigen Ausführung ab und liefert das Handle, über das die aktuelle
 * Ausführung ihre eigenen registriert. In Produktion (ohne `--hot`) ein
 * vollständiger No-op: nichts wird abgeräumt, nichts an `globalThis` gehängt.
 */
export async function initHotReload(options: HotReloadOptions = {}): Promise<HotReloadHandle> {
  const scope = (options.scope ?? globalThis) as Scope;
  const execArgv = options.execArgv ?? process.execArgv;
  const log = options.log ?? ((message: string) => console.log(message));
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  // Vorige Ausführung abräumen — das Register existiert nur, wenn eine gab
  // (und damit nur unter --hot, denn nur dort wird es installiert).
  const previous = scope[REGISTRY_KEY];
  let inherited = emptyHandoff();
  if (previous !== undefined) {
    delete scope[REGISTRY_KEY];
    log(`Hot-Reload: räume ${previous.steps.length} Listener/Timer der vorigen Ausführung ab…`);
    // Umgekehrte Reihenfolge: zuletzt Gebundenes zuerst geschlossen.
    for (const step of [...previous.steps].reverse()) {
      await runStep(step, stepTimeoutMs, log);
    }
    inherited = previous.handOver;
  }

  if (!isHotMode(execArgv)) {
    // Produktion: Wegwerf-Handle, das nichts speichert — `bun run start`
    // verhält sich exakt wie vor dieser Änderung.
    return { inherited, addCleanup: () => {}, handOver: emptyHandoff() };
  }

  // Register SOFORT installieren (nicht erst am Modulende), damit auch eine
  // mitten im Hochlauf scheiternde Ausführung ihre Schritte hinterlässt.
  const registry: HotReloadRegistry = { steps: [], handOver: emptyHandoff() };
  scope[REGISTRY_KEY] = registry;
  return {
    inherited,
    addCleanup: (name, dispose) => {
      registry.steps.push({ name, dispose });
    },
    handOver: registry.handOver,
  };
}
