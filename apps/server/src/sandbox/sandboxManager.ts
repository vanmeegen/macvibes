import type {
  PreviewStatus,
  SandboxContext,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from './provider';
import { DomainError } from '../core/errors';

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
   * Wer schaut gerade zu (H11). Ein Betrachter = eine aktive
   * chatEvents-Subscription: `enter` beim Aufbau, `leave` beim Ende des
   * Iterators — auch bei Tab-Schliessen, Reload, Crash und Netzabriss, denn
   * der GraphQL-Server beendet den Iterator dann selbst. `leave` ist bewusst
   * ownership-frei (R10, Besucher zählen mit); die Absicherung: Grace greift
   * erst, wenn der LETZTE Betrachter gegangen ist, und die Schlüssel sind
   * serverseitig erzeugt — ein Fremder kann keinen fremden Betrachter austragen.
   *
   * KEINE Obergrenze/LRU: die Set-Größe ist durch die tatsächlich lebenden
   * Subscriptions (offene Verbindungen) begrenzt. Eine LRU wäre schlimmer als
   * das frühere Leck — verdrängt sie einen noch lebenden Betrachter, wird
   * dessen `leave` zum No-op, der Refcount fällt nie auf 0, die VM stoppt nie.
   *
   * Die Einträge folgen der Lebensdauer der SUBSCRIPTION, nicht der VM: sie
   * überleben einen VM-Stopp (stop() leert das Set nicht) und werden allein
   * durch das garantierte `leave` am Subscription-Ende ausgetragen — auch
   * dann, wenn die VM zu diesem Zeitpunkt gestoppt ist.
   */
  viewers: Set<string>;
}

/** Mindestabstand zwischen zwei VM-Berührungen (ADR 0003). */
const DEFAULT_VM_TOUCH_INTERVAL_MS = 60_000;

/**
 * Schlüssel eines Betrachters im Refcount (H11).
 *
 * Enthält die VERBINDUNG, nicht nur den Nutzer: öffnete dieselbe Person
 * dasselbe Projekt zweimal, fügte der zweite Eintritt sonst nichts hinzu, und
 * das Ende der ersten Verbindung stellte den Grace-Timer scharf — die VM starb
 * unter der noch offenen zweiten.
 *
 * Die Verbindungskennung erzeugt der SERVER pro chatEvents-Subscription
 * (crypto.randomUUID): eindeutig ohne Kollisionsrisiko (#12) und von außen
 * nicht erratbar.
 */
export function viewerKey(userId: string, connectionId: string): string {
  return `${userId}:${connectionId}`;
}

export class SandboxManager {
  private readonly entries = new Map<string, SandboxEntry>();

  constructor(private readonly options: SandboxManagerOptions) {}

  /**
   * Sandbox betreten. `viewer` identifiziert den Betrachter (eine aktive
   * chatEvents-Subscription, H11) und ist Pflicht, damit `leave` weiß, wer
   * wieder gegangen ist.
   */
  enter(context: SandboxContext, viewer: string): Promise<void> {
    // KEIN async/await-Wrapper: der reichte die Promise einen Microtask später
    // weiter und verschöbe die fein austarierten Lebenszyklus-Rennen (#9).
    return this.acquire(context, viewer);
  }

  /**
   * Sandbox eager starten, OHNE einen Betrachter zu zählen (enterProject,
   * sendMessage). Der Refcount gehört allein der chatEvents-Subscription:
   * nur deren Ende ist ein verlässliches "Betrachter ist gegangen"-Signal —
   * eine Mutation kommt bei Reload/Crash/Netzabriss nie. Folgt dem Eager-Start
   * innerhalb der Grace-Period keine Subscription, stoppt die Sandbox wieder:
   * ein enterProject-Dauerfeuer (#2) pinnt nichts dauerhaft offen.
   */
  ensureRunning(context: SandboxContext): Promise<void> {
    return this.acquire(context, null);
  }

  /** Gemeinsamer Kern von enter (mit Betrachter) und ensureRunning (ohne). */
  private async acquire(context: SandboxContext, viewer: string | null): Promise<void> {
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
      if (viewer !== null) {
        existing.viewers.add(viewer);
        this.clearGrace(existing);
      }
      try {
        await existing.startPromise;
      } catch (error) {
        // Gescheiterter enter(): die Subscription kommt nie zustande, ihr
        // garantiertes leave (releaseOnClose) wird nie installiert. Da die
        // Betrachter VM-Stopps überleben, den eben gesetzten Eintrag selbst
        // zurücknehmen — sonst bliebe er als Stale-Eintrag für immer stehen.
        if (viewer !== null) existing.viewers.delete(viewer);
        throw error;
      }
      this.touch(existing);
      return;
    }
    if (existing && existing.status === 'running') {
      if (viewer !== null) {
        existing.viewers.add(viewer);
        this.clearGrace(existing);
      } else if (existing.viewers.size === 0) {
        // Eager-Start ohne Betrachter auf laufender VM: Grace (neu) aufziehen,
        // damit die Invariante "keine Betrachter ⇒ Grace läuft" bestehen bleibt.
        this.armGrace(existing);
      }
      this.touch(existing);
      return;
    }

    // Betrachter des gestoppten Vorgaenger-Eintrags UEBERNEHMEN (H11): die
    // Eintraege gehoeren zur Lebensdauer der Subscription, nicht der VM. Eine
    // offene Subscription ueberlebt einen VM-Stopp (der SSE-Stream reisst
    // dabei nicht ab) und traegt sich nie erneut ein — begaenne der Neustart
    // bei 0, waere Grace scharf und stoppte die VM unter dem offenen Tab.
    const viewers = existing?.viewers ?? new Set<string>();
    if (viewer !== null) viewers.add(viewer);
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
      viewers,
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
        // Nur auf `stopped` schalten, wenn nicht bereits ein Stopp läuft — der
        // hat den Status schon auf `stopping` gesetzt und räumt selbst auf.
        if (entry.stopPromise === null) this.setStatus(entry, 'stopped');
        throw error;
      }
      // Wurde WÄHREND des Starts ein Stopp angefordert (stopPromise gesetzt),
      // NICHT auf `running` schalten: der laufende stopWork übernimmt das eben
      // gesetzte Handle und stoppt es. Sonst stünde der Eintrag kurz auf
      // `running`, obwohl er gerade stirbt, und ein paralleles enter() träte
      // einer sterbenden Sandbox bei.
      if (entry.stopPromise === null) {
        this.setStatus(entry, 'running');
        this.touch(entry);
        // Eager-Start ohne (inzwischen) verbliebenen Betrachter: Grace sofort
        // scharf — kommt keine Subscription nach, stoppt die VM wieder (H11).
        if (entry.viewers.size === 0) this.armGrace(entry);
      }
    })();
    entry.startPromise = startWork;
    try {
      await startWork;
    } catch (error) {
      // Wie im starting-Pfad oben: ein gescheiterter enter() muss seinen
      // Betrachter-Eintrag selbst zurücknehmen (kein garantiertes leave, weil
      // die Subscription nie zustande kommt).
      if (viewer !== null) entry.viewers.delete(viewer);
      throw error;
    } finally {
      entry.startPromise = null;
    }
  }

  /**
   * Sandbox freigeben — beim Ende der chatEvents-Subscription des Betrachters.
   * Grace wird erst scharf, wenn der letzte Betrachter gegangen ist (H11) — ein
   * `leave` eines Fremden, während der Eigentümer noch zusieht, bleibt damit
   * wirkungslos. Ein `leave` für einen Betrachter, der nie eingetreten ist,
   * ändert gar nichts.
   */
  leave(projectId: string, viewer: string): void {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    // Den Eintrag IMMER austragen, auch bei gestoppter VM: die Betrachter-
    // Eintraege ueberleben einen VM-Stopp (H11), also muss auch das leave
    // einer Subscription, die waehrend des Stopps endet, den Stand bereinigen —
    // sonst zaehlte ein toter Betrachter beim naechsten Start weiter und
    // hielte die VM ohne Zuschauer bis zum Idle-Stopp am Leben.
    if (!entry.viewers.delete(viewer)) return;
    // Grace nur scharf stellen, wenn ueberhaupt etwas laeuft, das zu stoppen
    // waere — und nur, wenn der LETZTE Betrachter gegangen ist.
    if (entry.status !== 'running' && entry.status !== 'starting') return;
    if (entry.viewers.size > 0) return;
    this.armGrace(entry);
  }

  /** Zahl der aktuell gezählten Betrachter (H11-Refcount, lebende Subscriptions). */
  viewerCount(projectId: string): number {
    return this.entries.get(projectId)?.viewers.size ?? 0;
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

    // Status und stopPromise SYNCHRON setzen, BEVOR irgendein await folgt —
    // auch bevor auf einen laufenden Start gewartet wird. Sonst sieht ein
    // paralleles enter() den Eintrag in diesem Fenster noch als `starting` und
    // hängt sich an den gerade sterbenden Start, statt auf den Stopp zu warten.
    const startPromise = entry.startPromise;
    this.clearGrace(entry);
    this.clearIdle(entry);
    this.setStatus(entry, 'stopping');

    const stopWork = (async () => {
      // Läuft noch ein START, muss der ZUERST fertig werden. Sonst stoppt dieser
      // Aufruf nichts (entry.handle ist während des Starts null) — und der Start
      // setzte danach das Handle. Der Start schaltet den Eintrag nicht mehr auf
      // `running`, weil stopPromise bereits gesetzt ist; er übergibt uns nur das
      // Handle.
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // Ein gescheiterter Start hinterlässt nichts zu stoppen. Der Fehler
          // gehört dem enter()-Aufrufer, der ihn ohnehin bekommt.
        }
      }

      // onBeforeStop (Auto-Commit) nur, wenn wirklich eine VM läuft: ein
      // gescheiterter Start hinterlässt kein Handle, dann gibt es nichts zu
      // committen.
      if (this.options.onBeforeStop && entry.handle) {
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
        // `viewers` bleibt BEWUSST stehen (H11): die Betrachter-Einträge
        // gehören zur Lebensdauer der SUBSCRIPTION, nicht der VM. Eine offene
        // Subscription überlebt den VM-Stopp (der SSE-Stream reißt dabei nicht
        // ab) und trägt sich nie erneut ein — leerte stop() das Set, sähe ein
        // späterer Neustart (ensureRunning nach sendMessage) 0 Betrachter,
        // Grace würde scharf und stoppte die VM unter dem offenen Tab.
        // Stale-Einträge entstehen dadurch nicht: das garantierte leave am
        // Ende jeder Subscription (releaseOnClose) räumt jeden Eintrag
        // zuverlässig aus, auch während die VM gestoppt ist.
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

  /**
   * Vergisst ein Projekt vollständig — für gelöschte Projekte.
   *
   * Ohne das blieb der Eintrag samt Kontext, Betrachter-Set und Timern für die
   * Lebensdauer des Prozesses liegen, auch wenn es das Projekt gar nicht mehr
   * gab. Der Aufrufer muss vorher `stop()` aufrufen; `forget` räumt nur den
   * Buchhaltungsteil ab und startet oder stoppt nichts.
   */
  forget(projectId: string): void {
    const entry = this.entries.get(projectId);
    if (entry === undefined) return;
    // Ist die Sandbox nicht (mehr) gestoppt, ist zwischen dem stop() des
    // Aufrufers und diesem forget() ein enter() dazwischengekommen und hat sie
    // neu gestartet (Randfall: gelöschtes Projekt, gleichzeitiger Zugriff). Den
    // Eintrag NICHT löschen — sonst liefe die MicroVM ohne Handle zum Stoppen
    // weiter. Stattdessen erneut stoppen; der Eintrag bleibt so lange in der
    // Buchhaltung, bis dieser Stopp ihn auf `stopped` gesetzt hat.
    if (entry.status !== 'stopped') {
      console.warn(
        `forget(${projectId}): Sandbox ist ${entry.status} — erneut stoppen statt vergessen ` +
          '(gleichzeitiger enter auf ein gelöschtes Projekt?).',
      );
      void this.stop(projectId).catch((error: unknown) => {
        console.error(`Nachträglicher Stopp für ${projectId} schlug fehl:`, error);
      });
      return;
    }
    this.clearGrace(entry);
    this.clearIdle(entry);
    // HIER ist das Leeren richtig (anders als in stop(), wo die Betrachter den
    // VM-Stopp überleben müssen): forget läuft nur bei Projektlöschung, und
    // dort sind die Einträge wertlos — deleteProject ruft chatService.forget,
    // das die Subscriber-Registrierung leert (die Iteratoren enden erst mit dem
    // Client-Disconnect, liefern aber nichts mehr). Ihr garantiertes leave
    // (releaseOnClose) findet danach keinen Eintrag mehr und ist ein No-op.
    entry.viewers.clear();
    this.entries.delete(projectId);
  }

  /**
   * Entschärft alle Grace-/Idle-Timer, OHNE Sandboxes zu stoppen — NUR für den
   * Dev-Hot-Reload (`bun --hot`, s. devHotReload.ts).
   *
   * Beim Reload lebt dieser Manager als verwaistes Objekt weiter; seine Timer
   * würden sonst später feuern und `stop()` auslösen — also Auto-Commit plus
   * VM-Stopp durch eine ALTE Ausführung, deren Sicht (isBusy, chatService)
   * längst veraltet ist. Genau das darf ein Reload nicht: laufende MicroVMs
   * bleiben unangetastet, nur die Host-Listener werden erneuert. Verwaiste VMs
   * fängt weiterhin die VM-eigene Idle-Frist (ADR 0003) auf. Bewusst KEIN
   * `stopAll()` und KEIN Eingriff in die Provider-Handles (deren Poller/
   * Supervisor überwachen die weiterlaufenden Sandboxes zu Recht weiter).
   */
  detachForReload(): void {
    for (const entry of this.entries.values()) {
      this.clearGrace(entry);
      this.clearIdle(entry);
    }
  }

  /** Wie viele Projekte im Speicher gehalten werden (die Zahl hinter dem Leck). */
  trackedProjects(): number {
    return this.entries.size;
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
      // Nur LAUFENDE Sandboxes kommen als Opfer infrage, nie startende. Eine
      // gerade startende zu stoppen hiesse, in stop() auf ihr startPromise zu
      // warten — und da die Eviction SELBST aus einem laufenden Start heraus
      // aufgerufen wird, können sich zwei parallele enter() darüber
      // wechselseitig blockieren (Deadlock). Startende zählen weiter zur
      // Kapazität (active()), damit nicht zu viele VMs gleichzeitig hochkommen;
      // sind die überzähligen Plätze aber alle noch am Starten, wird gewartet
      // (CapacityError) statt einen Start abzuwürgen.
      const candidates = active().filter(
        (e) => e.status === 'running' && this.options.isBusy?.(e.context.projectId) !== true,
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
