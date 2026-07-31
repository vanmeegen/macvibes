import type {
  PreviewStatus,
  SandboxContext,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from './provider';
import { DomainError } from '../services/errors';

/**
 * Alle Plätze belegt und keiner davon verdrängbar (F20). Erbt von DomainError,
 * damit die Meldung den Nutzer erreicht, statt als interner Fehler maskiert zu
 * werden — der Aufrufer soll warten, nicht eine fremde, arbeitende VM verlieren.
 */
export class SandboxCapacityError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxCapacityError';
  }
}

export interface SandboxManagerOptions {
  provider: SandboxProvider;
  /** Stopp-Verzögerung nach Verlassen der Chat-Page (R9). */
  graceMs: number;
  /** Stopp nach Agent-Inaktivität, auch bei offener Chat-Page (R9). */
  idleMs: number;
  /** Maximal gleichzeitige Sandboxes; darüber wird per LRU verdrängt (R9). */
  maxSandboxes: number;
  /** Hook vor jedem Stopp — Auto-Commit eines offenen Stands (R8/R9). */
  onBeforeStop?: (projectId: string) => Promise<void>;
  onStatusChange?: (projectId: string, status: SandboxStatus) => void;
  /**
   * Läuft gerade ein Agent-Turn? Der Grace-Stopp schiebt sich dann um eine
   * weitere Grace-Period auf, statt den Turn mitten drin zu killen.
   */
  isBusy?: (projectId: string) => boolean;
  /**
   * Setzt die Idle-Frist der VM zurück (ADR 0003). Fehlt sie, verhält sich der
   * Manager wie bisher — nützlich für Tests und den Process-Provider.
   */
  touchSandbox?: (projectId: string) => Promise<void>;
  /**
   * Mindestabstand zwischen zwei VM-Berührungen. noteAgentActivity feuert bei
   * JEDEM Agent-Event (also pro Text-Delta) — ungedrosselt wären das dreistellig
   * viele API-Aufrufe pro Turn. Default 60 s; die VM-Frist liegt bei 45 min.
   */
  vmTouchIntervalMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

interface SandboxEntry {
  context: SandboxContext;
  status: SandboxStatus;
  handle: SandboxHandle | null;
  lastActivityAt: number;
  graceTimer: Timer | null;
  idleTimer: Timer | null;
  /** Läuft der Start gerade? Zweite enter()-Aufrufe warten darauf (Race-Fix). */
  startPromise: Promise<void> | null;
  /** Läuft der Stopp gerade? enter() wartet darauf, statt zu überschreiben (F17). */
  stopPromise: Promise<void> | null;
  /** Wann zuletzt die Idle-Frist der VM zurückgesetzt wurde (ADR 0003). */
  lastVmTouchAt: number;
  /**
   * Wer schaut gerade zu (H11). `leaveProject` ist bewusst ownership-frei, damit
   * Besucher fremde Sandboxes wieder freigeben können (R10) — ohne Refcount
   * stellte damit aber ein einzelner fremder Aufruf den Grace-Timer scharf und
   * stoppte die VM des Eigentümers, samt Auto-Commit in dessen Branch. Grace
   * greift deshalb erst, wenn der LETZTE Betrachter gegangen ist.
   */
  viewers: Set<string>;
}

/** Mindestabstand zwischen zwei VM-Berührungen (ADR 0003). */
const DEFAULT_VM_TOUCH_INTERVAL_MS = 60_000;

export class SandboxManager {
  private readonly entries = new Map<string, SandboxEntry>();

  constructor(private readonly options: SandboxManagerOptions) {}

  /**
   * Sandbox betreten. `viewer` identifiziert den Betrachter (Nutzer-ID) und ist
   * Pflicht, damit `leave` weiß, wer wieder gegangen ist (H11).
   */
  async enter(context: SandboxContext, viewer: string): Promise<void> {
    let existing = this.entries.get(context.projectId);
    // Ein laufender Stopp muss ZUERST fertig werden (F17): sonst startet hier
    // eine neue VM unter demselben msb-Namen, während stop() noch auf den
    // Auto-Commit wartet — und räumt sie anschließend gleich wieder ab.
    if (existing && existing.status === 'stopping' && existing.stopPromise) {
      await existing.stopPromise;
      existing = this.entries.get(context.projectId);
    }
    if (existing && existing.status === 'starting' && existing.startPromise) {
      // Start läuft schon — darauf warten, damit der Agent nicht auf eine noch
      // nicht exec-bereite VM losfeuert ("no agent endpoint found", Race-Fix).
      existing.viewers.add(viewer);
      this.clearGrace(existing);
      await existing.startPromise;
      this.touch(existing);
      return;
    }
    if (existing && existing.status === 'running') {
      existing.viewers.add(viewer);
      this.clearGrace(existing);
      this.touch(existing);
      return;
    }

    const entry: SandboxEntry = {
      context,
      status: 'stopped',
      handle: null,
      lastActivityAt: Date.now(),
      graceTimer: null,
      idleTimer: null,
      startPromise: null,
      stopPromise: null,
      lastVmTouchAt: 0,
      viewers: new Set([viewer]),
    };
    this.entries.set(context.projectId, entry);
    // Status und startPromise SYNCHRON setzen, bevor irgendein await folgt:
    // sonst sieht ein zweiter enter() den Eintrag noch als `stopped`, legt
    // einen eigenen an und startet dieselbe Sandbox ein zweites Mal — zwei
    // VMs unter demselben msb-Namen und zwei ausgestellte VM-Tokens.
    this.setStatus(entry, 'starting');
    const startWork = (async () => {
      try {
        await this.evictLeastActiveIfNeeded(context.projectId);
        entry.handle = await this.options.provider.start(context);
      } catch (error) {
        this.setStatus(entry, 'stopped');
        throw error;
      }
      this.setStatus(entry, 'running');
      this.touch(entry);
    })();
    entry.startPromise = startWork;
    try {
      await startWork;
    } finally {
      entry.startPromise = null;
    }
  }

  /**
   * Sandbox freigeben. Grace wird erst scharf, wenn der letzte Betrachter
   * gegangen ist (H11) — ein `leave` eines Fremden, während der Eigentümer noch
   * zusieht, bleibt damit wirkungslos. Ein `leave` für einen Betrachter, der nie
   * eingetreten ist, ändert gar nichts.
   */
  leave(projectId: string, viewer: string): void {
    const entry = this.entries.get(projectId);
    if (!entry || (entry.status !== 'running' && entry.status !== 'starting')) return;
    if (!entry.viewers.delete(viewer)) return;
    if (entry.viewers.size > 0) return;
    this.armGrace(entry);
  }

  /**
   * Grace-Timer scharf stellen. Läuft beim Ablauf noch ein Agent-Turn
   * (isBusy), verschiebt sich der Stopp um eine weitere Grace-Period —
   * ein Turn wird nie mitten drin gekillt, nur weil die Chat-Page zu ist.
   */
  private armGrace(entry: SandboxEntry): void {
    this.clearGrace(entry);
    entry.graceTimer = setTimeout(() => {
      entry.graceTimer = null;
      if (this.options.isBusy?.(entry.context.projectId)) {
        this.armGrace(entry);
        return;
      }
      void this.stop(entry.context.projectId);
    }, this.options.graceMs);
  }

  noteAgentActivity(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (!entry || entry.status !== 'running') return;
    this.touch(entry);
  }

  status(projectId: string): SandboxStatus {
    return this.entries.get(projectId)?.status ?? 'stopped';
  }

  previewHostPort(projectId: string): number | null {
    const entry = this.entries.get(projectId);
    if (!entry || entry.status !== 'running') return null;
    return entry.handle?.previewHostPort ?? null;
  }

  /** Zustand des Dev-Servers laut Watchdog (für das UI-Overlay, R7). */
  previewStatus(projectId: string): PreviewStatus {
    const entry = this.entries.get(projectId);
    if (!entry || entry.status !== 'running' || !entry.handle) return 'stopped';
    return entry.handle.previewStatus();
  }

  async stop(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    // Läuft der Stopp schon, denselben abwarten statt ihn zu doppeln (F17).
    if (entry.status === 'stopping' && entry.stopPromise) return entry.stopPromise;
    if (entry.status !== 'running' && entry.status !== 'starting') return;

    this.clearGrace(entry);
    this.clearIdle(entry);
    this.setStatus(entry, 'stopping');

    const stopWork = (async () => {
      if (this.options.onBeforeStop) {
        try {
          await this.options.onBeforeStop(projectId);
        } catch (error) {
          // Auto-Commit-Fehler dürfen den Stopp nicht blockieren, aber nie
          // stillschweigend verschwinden (Konvention: keine verschluckten Fehler).
          console.error(`onBeforeStop für ${projectId} schlug fehl:`, error);
        }
      }

      try {
        await entry.handle?.stop();
      } finally {
        entry.handle = null;
        // Betrachterstand fällt mit der VM: ein alter Eintrag würde sonst den
        // nächsten Start blockieren, weil sein leave nie mehr käme (H11).
        entry.viewers.clear();
        this.setStatus(entry, 'stopped');
      }
    })();
    entry.stopPromise = stopWork;
    try {
      await stopWork;
    } finally {
      entry.stopPromise = null;
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((projectId) => this.stop(projectId)));
  }

  private touch(entry: SandboxEntry): void {
    entry.lastActivityAt = Date.now();
    this.clearIdle(entry);
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      void this.stop(entry.context.projectId);
    }, this.options.idleMs);
    this.touchVm(entry);
  }

  /**
   * Setzt die Idle-Frist der VM zurück (ADR 0003) — gedrosselt und
   * fire-and-forget.
   *
   * Fire-and-forget ist hier Absicht: Dieser Aufruf hängt im Pfad jedes
   * Agent-Events. Ein langsames oder hängendes msb darf einen laufenden Turn
   * unter keinen Umständen aufhalten. Ein Fehler wird geloggt, nicht
   * verschluckt — er ist folgenlos, weil die VM-Frist ein Auffangnetz ist und
   * der host-seitige Idle-Timer unabhängig davon weiterläuft.
   */
  private touchVm(entry: SandboxEntry): void {
    const touchSandbox = this.options.touchSandbox;
    if (!touchSandbox) return;
    const intervalMs = this.options.vmTouchIntervalMs ?? DEFAULT_VM_TOUCH_INTERVAL_MS;
    const jetzt = Date.now();
    if (jetzt - entry.lastVmTouchAt < intervalMs) return;
    entry.lastVmTouchAt = jetzt;
    void touchSandbox(entry.context.projectId).catch((error: unknown) => {
      console.error(`VM-Idle-Frist für ${entry.context.projectId} nicht zurückgesetzt:`, error);
    });
  }

  private setStatus(entry: SandboxEntry, status: SandboxStatus): void {
    entry.status = status;
    this.options.onStatusChange?.(entry.context.projectId, status);
  }

  private clearGrace(entry: SandboxEntry): void {
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
  }

  private clearIdle(entry: SandboxEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private async evictLeastActiveIfNeeded(enteringProjectId: string): Promise<void> {
    const active = () =>
      [...this.entries.values()].filter(
        (e) =>
          e.context.projectId !== enteringProjectId &&
          (e.status === 'running' || e.status === 'starting'),
      );

    while (active().length >= this.options.maxSandboxes) {
      // Beschäftigte Sandboxes sind tabu (F20): `enter` ist bewusst ohne
      // Ownership erreichbar, sonst könnte ein Nutzer die Plätze mit fremden
      // Projekten füllen und dabei laufende Turns anderer abbrechen.
      // Ownership selbst bleibt außen vor — sonst blockiert ein Einzelner
      // die gesamte Kapazität.
      const candidates = active().filter(
        (e) => this.options.isBusy?.(e.context.projectId) !== true,
      );
      if (candidates.length === 0) {
        throw new SandboxCapacityError(
          'Alle Sandbox-Plätze sind belegt und beschäftigt — bitte kurz warten.',
        );
      }
      const victim = candidates.reduce((oldest, e) =>
        e.lastActivityAt < oldest.lastActivityAt ? e : oldest,
      );
      await this.stop(victim.context.projectId);
    }
  }
}
