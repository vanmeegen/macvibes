import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { DEFAULT_AGENT_MODEL, agentTimeoutsFor, isSlowAgentModel } from '../agent/agentModel';
import type { AgentEvent } from '../agent/events';
import type { AgentRunner, TurnHandle } from '../agent/runner';
import type { Db } from '../db/client';
import { chatMessages, projects, type ChatMessageRow, type UserRow } from '../db/schema';
import { getProject, getProjectOwned } from './projectsService';

/**
 * Obergrenze pro Chat-Zeile (F16). Jedes Delta schreibt die komplette Zeile
 * per UPDATE und broadcastet sie an alle Abonnenten — ohne Deckel wächst das
 * unbegrenzt, im Missbrauchsfall bis zur Sättigung von Speicher und Platte.
 */
export const MAX_MESSAGE_CHARS = 200_000;

/**
 * Wie viele Zeilen die Kontext-Wiederherstellung höchstens aus der DB holt.
 * Sie behält davon 30 (nur user/assistant, ohne den laufenden Turn) — vorher
 * wurde dafür die KOMPLETTE Historie des Projekts geladen.
 */
export interface ChatEventPayload {
  message: ChatMessageRow;
  /** Läuft für dieses Projekt gerade (oder gleich, Queue) ein Agent-Turn? */
  turnActive: boolean;
}

export interface ChatHooks {
  /** Für den Idle-Timer der Sandbox (R9). */
  onAgentActivity?: (projectId: string) => void;
  /** Nach jedem abgeschlossenen Turn — Auto-Commit (R8, B4). */
  onTurnEnd?: (projectId: string, userPrompt: string) => Promise<void>;
}

export interface SendMessageInput {
  projectId: string;
  workspaceDir: string;
  text: string;
  /** Mid-Turn-Steering (Phase C): laufenden Turn abbrechen und neu ansetzen. */
  interrupt?: boolean;
}

interface QueuedTurn {
  turnId: string;
  prompt: string;
  workspaceDir: string;
}

interface ProjectChatState {
  queue: QueuedTurn[];
  pumpRunning: boolean;
  /**
   * Handle des laufenden Turns — das UMHÜLLTE aus `runAttempt`, nicht das des
   * Runners. Sein `abort()` markiert den Turn als Nutzerabbruch und beendet ihn
   * damit endgültig (kein Retry). Genau dafür liegt hier der Wrapper: der
   * Watchdog in `runAttempt` hat das rohe Handle und bricht ohne diese Wirkung
   * ab.
   */
  currentHandle: TurnHandle | null;
  /**
   * Die turnId, die die Pump GERADE verarbeitet — gesetzt, BEVOR der erste
   * await in `runTurn`/`runAttempt` kommt, geräumt, wenn der Turn endet. Sie
   * macht das Startfenster sichtbar, in dem ein Turn AKTIV ist, aber sein
   * Handle noch fehlt (Config-Warmup, DB-Abfrage in `runAttempt`): ein
   * Stop/Interrupt in diesem Fenster pinnt sich an GENAU diese turnId — nie
   * an „irgendeinen nächsten" Turn.
   */
  activeTurnId: string | null;
  /**
   * „Stop heißt Stop — Gegenwart, kein aufgeschobener Wunsch": Abbruch für den
   * Turn, der beim Stop/Interrupt gerade STARTETE (aktiv, aber noch ohne
   * Handle). Immer eine Kopie von `activeTurnId` im Moment des Abbruchs;
   * `runAttempt` löst ihn beim Handle-Setzen ein, wenn die turnId übereinstimmt,
   * und die Pump räumt ihn spätestens am Turn-Ende. Weil er an die AKTUELLE
   * turnId gepinnt ist, kann er keine später gestartete Nachricht treffen.
   */
  abortActiveTurnId: string | null;
  subscribers: Set<(payload: ChatEventPayload) => void>;
}

export interface ChatServiceOptions {
  /**
   * Reagiert der Agent so lange gar nicht (kein einziges Event), gilt der Turn
   * als hängend: er wird abgebrochen und der Hänger als Fehler sichtbar gemacht,
   * statt ewig auf „Agent arbeitet" zu stehen.
   */
  agentIdleTimeoutMs?: number | undefined;
  /**
   * Kommt nach dem Start GAR KEIN Event in dieser Zeit, ist der Start kaputt
   * (claudes init-Zeile kommt sonst in 1–3s) — sofort abbrechen/retryen statt
   * den vollen Idle-Timeout abzuwarten.
   */
  agentFirstEventTimeoutMs?: number | undefined;
  /**
   * Erster Turn eines Projekts = frisch geforkte VM + claude-First-Run; das
   * dauert deutlich länger als ein Folge-Turn. Für diesen Kaltstart gilt ein
   * großzügigerer First-Event-Timeout (der User sieht derweil „MicroVM startet").
   */
  agentColdStartTimeoutMs?: number | undefined;
  /** Frist für den Config-Warmup (Default 60s). */
  agentWarmupTimeoutMs?: number | undefined;
  /** Nachlauf nach dem Abbruch, um einen späten Fehlertext (stderr) einzusammeln. */
  agentAbortGraceMs?: number | undefined;
  /**
   * Timeout-Varianten für LANGSAME (lokale) Modelle — die denken vor dem ersten
   * sichtbaren Token deutlich länger. Welche Variante greift, entscheidet das
   * Projekt-Modell pro Turn (agentTimeoutsFor).
   */
  agentSlowIdleTimeoutMs?: number | undefined;
  agentSlowFirstEventTimeoutMs?: number | undefined;
  agentSlowColdStartTimeoutMs?: number | undefined;
  /**
   * Stillen Config-Warmup beim Projekt-Öffnen ausführen. Default true (Claude).
   * Bei langsamen lokalen Modellen abschalten — der Warmup belegt sonst den
   * Ein-Turn-Daemon und der erste echte Prompt wird abgewiesen.
   */
  prewarmEnabled?: boolean | undefined;
}

export class ChatService {
  private readonly states = new Map<string, ProjectChatState>();
  /** Laufende Config-Warmups pro Projekt (siehe prewarm). */
  private readonly warmups = new Map<string, Promise<void>>();
  private readonly idleTimeoutMs: number;
  private readonly firstEventTimeoutMs: number;
  private readonly coldStartTimeoutMs: number;
  /** Frist für den stillen Config-Warmup — er blockiert sonst den echten Turn. */
  private readonly warmupTimeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly slowIdleTimeoutMs: number;
  private readonly slowFirstEventTimeoutMs: number;
  private readonly slowColdStartTimeoutMs: number;
  private readonly prewarmEnabled: boolean;

  constructor(
    private readonly db: Db,
    private readonly runner: AgentRunner,
    private readonly hooks: ChatHooks = {},
    options: ChatServiceOptions = {},
  ) {
    this.idleTimeoutMs = options.agentIdleTimeoutMs ?? 180_000;
    // Nie länger warten als der Idle-Timeout — der Start-Timeout ist die UNTERE Schranke.
    this.firstEventTimeoutMs = Math.min(
      options.agentFirstEventTimeoutMs ?? 8_000,
      this.idleTimeoutMs,
    );
    this.coldStartTimeoutMs = Math.min(
      options.agentColdStartTimeoutMs ?? 30_000,
      this.idleTimeoutMs,
    );
    this.abortGraceMs = options.agentAbortGraceMs ?? 5_000;
    this.slowIdleTimeoutMs = options.agentSlowIdleTimeoutMs ?? 600_000;
    this.warmupTimeoutMs = options.agentWarmupTimeoutMs ?? 60_000;
    this.slowFirstEventTimeoutMs = Math.min(
      options.agentSlowFirstEventTimeoutMs ?? 180_000,
      this.slowIdleTimeoutMs,
    );
    this.slowColdStartTimeoutMs = Math.min(
      options.agentSlowColdStartTimeoutMs ?? 300_000,
      this.slowIdleTimeoutMs,
    );
    this.prewarmEnabled = options.prewarmEnabled ?? true;
  }

  private state(projectId: string): ProjectChatState {
    let state = this.states.get(projectId);
    if (!state) {
      state = {
        queue: [],
        pumpRunning: false,
        currentHandle: null,
        activeTurnId: null,
        abortActiveTurnId: null,
        subscribers: new Set(),
      };
      this.states.set(projectId, state);
    }
    return state;
  }

  async listMessages(projectId: string): Promise<ChatMessageRow[]> {
    return this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.projectId, projectId))
      .orderBy(sql`rowid`, asc(chatMessages.createdAt));
  }

  isTurnActive(projectId: string): boolean {
    // Ein Config-Warmup belegt den Ein-Turn-Daemon genauso wie ein echter
    // Turn — Grace-Stopp und LRU-Eviction (isBusy) dürfen die VM nicht unter
    // ihm wegstoppen (N9). Der Eintrag verschwindet garantiert im finally
    // von prewarm — kein Dauer-busy-Risiko.
    if (this.warmups.has(projectId)) return true;
    const state = this.states.get(projectId);
    if (!state) return false;
    return state.pumpRunning || state.queue.length > 0 || state.currentHandle !== null;
  }

  /**
   * Wärmt die claude-Config einer frisch geforkten VM vor: ein stiller
   * Wegwerf-Turn (Output verworfen, keine Chat-Nachricht), der beim Öffnen des
   * Projekts läuft, während der User seinen ersten Prompt tippt. Ohne dies
   * trägt der ERSTE echte Turn den ganzen claude-First-Run (~9s auf dem
   * gemounteten Volume) — mit Warmup ist er danach schnell. No-Op, wenn schon
   * ein Warmup läuft oder das Projekt bereits eine Session hat (Config warm).
   *
   * **Wirft nie.** Der Aufrufer (GraphQL-Resolver) startet den Warmup
   * fire-and-forget; eine Rejection hätte dort keinen Handler und beendete den
   * ganzen Serverprozess — eine SQLITE_BUSY beim Öffnen EINES Projekts risse
   * damit alle anderen Sitzungen und alle laufenden MicroVMs mit. Der Warmup
   * ist reine Beschleunigung: scheitert er, geht es ohne ihn weiter.
   *
   * Der Eintrag in `warmups` wird nach dem Lauf wieder entfernt. Er verhindert
   * nur einen ZWEITEN gleichzeitigen Warmup — bliebe er liegen, wäre `prewarm`
   * für dieses Projekt dauerhaft wirkungslos, auch nach erneutem Öffnen mit
   * einer frischen VM, deren Config wieder kalt ist.
   *
   * Owner-only, und die Prüfung hängt HIER am Service (M5) — aber als
   * FEATURE-GATING, nicht als Authz-Ablehnung: ein Besucher bekommt schlicht
   * keinen Warmup (stille Rückkehr). Ein Wurf wäre falsch — er machte
   * enterProject für Nur-Lese-Besucher (R10) kaputt, und es gibt nichts
   * abzulehnen: der Warmup ist ein Beschleuniger, kein Nutzerbefehl.
   */
  async prewarm(user: UserRow, projectId: string, workspaceDir: string): Promise<void> {
    if (!this.prewarmEnabled) return;
    if (this.warmups.has(projectId)) return;
    // Der Aufrufer (schema/index.ts) startet prewarm als floating promise. Eine
    // Rejection hätte dort keinen Handler und beendete den ganzen Serverprozess
    // — eine SQLITE_BUSY beim Öffnen EINES Projekts risse damit alle anderen
    // Sitzungen und alle laufenden MicroVMs mit. Der Warmup ist reine
    // Beschleunigung: scheitert er, geht es ohne ihn weiter.
    let projectRow;
    try {
      projectRow = (
        await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
      )[0];
    } catch (error) {
      console.error(`Config-Warmup für ${projectId} nicht gestartet (DB-Fehler):`, error);
      return;
    }
    // Feature-Gating (M5, s. Methodenkommentar): fremdes oder unbekanntes
    // Projekt → STILL zurück, kein Wurf. Vorwärmen dürfte sonst jeder
    // Transport, der den Resolver-Branch vergisst, für fremde Projekte —
    // und belegte damit deren Ein-Turn-Daemon.
    if (projectRow === undefined || projectRow.ownerId !== user.id) return;
    if (projectRow.claudeSessionId != null) return;
    const model = projectRow?.agentModel ?? DEFAULT_AGENT_MODEL;
    // Langsame lokale Modelle NICHT vorwärmen: der minutenlange Warmup belegt
    // den Ein-Turn-Daemon und der erste echte Prompt würde abgewiesen.
    if (isSlowAgentModel(model)) return;
    // Eintrag nach dem Lauf wieder entfernen: er dient nur dazu, einen ZWEITEN
    // gleichzeitigen Warmup zu verhindern. Blieb er liegen, war prewarm für
    // dieses Projekt dauerhaft wirkungslos — auch nach Schliessen und erneutem
    // Öffnen mit einer frischen VM, deren Config wieder kalt ist.
    const lauf = this.runWarmup(projectId, workspaceDir, model).finally(() => {
      this.warmups.delete(projectId);
    });
    this.warmups.set(projectId, lauf);
  }

  private async runWarmup(projectId: string, workspaceDir: string, model: string): Promise<void> {
    try {
      const handle = this.runner.startTurn({
        projectId,
        prompt: 'Antworte nur mit dem Wort: bereit',
        workspaceDir,
        resumeSessionId: null,
        model,
      });
      // Der Warmup MUSS eine Frist haben: der echte Turn wartet auf ihn
      // (runAttempt), bevor er in seine eigene Timeout-Schleife kommt. Ohne
      // Frist hängt ein stiller Warmup — etwa weil die Claude-API nicht
      // antwortet — das Projekt unbegrenzt auf, und im UI steht ewig
      // „Agent arbeitet", ohne dass je ein Fehler sichtbar wird.
      const deadline = Date.now() + this.warmupTimeoutMs;
      const consume = (async () => {
        // Events konsumieren und VERWERFEN — der Warmup initialisiert nur die
        // claude-Config in der VM, er erzeugt keine Chat-Nachrichten.
        for await (const event of handle.events) {
          void event;
        }
      })();
      const abgelaufen = await Promise.race([
        consume.then(() => false),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => true),
      ]);
      if (abgelaufen) {
        console.warn(
          `Config-Warmup für ${projectId} nach ${Math.round(this.warmupTimeoutMs / 1000)}s ` +
            'abgebrochen — der Agent antwortet nicht. Der nächste echte Turn läuft trotzdem.',
        );
        handle.abort();
      }
    } catch (error) {
      console.error(`Config-Warmup für ${projectId} fehlgeschlagen:`, error);
    }
  }

  /**
   * Persistiert die Nutzer-Nachricht sofort und reiht den Turn ein (Queue, R6).
   *
   * Mit `interrupt: true` wird zusätzlich der LAUFENDE Turn abgebrochen, damit
   * die Pump sofort zur neuen Nachricht springt (Mid-Turn-Steering). Zwei
   * Zusagen, auf die sich Aufrufer verlassen dürfen:
   *
   * - Die Queue bleibt erhalten — abgebrochen wird nur der laufende Turn.
   * - Der abgebrochene Turn wird NICHT wiederholt. Der Retry ist für
   *   msb-Flakes da; ein vom Nutzer veranlasster Abbruch ist keiner (s.
   *   `runTurn`).
   *
   * Ein `interrupt` bricht ab, was JETZT aktiv ist — niemals die eigene neue
   * Nachricht: hat die Pump sie während des `insertMessage`-awaits schon
   * selbst gestartet, ist SIE der aktive Turn und der Abbruch ein No-op
   * (`ausnahmeTurnId`). Es wird nichts vorgemerkt, das später einen anderen
   * Turn treffen könnte.
   *
   * Chatten ist Owner-only (R10) und die Prüfung hängt HIER am Service (M5):
   * sie greift damit für jeden Aufrufer — GraphQL-Resolver, Skript, künftiger
   * Transport —, nicht nur für den, der an sie denkt. Bewusst VOR jedem
   * Effekt (kein state()-Eintrag, keine persistierte Zeile, kein Turn).
   */
  async sendMessage(user: UserRow, input: SendMessageInput): Promise<void> {
    await getProjectOwned(this.db, user, input.projectId);
    const state = this.state(input.projectId);
    const turnId = crypto.randomUUID();
    state.queue.push({ turnId, prompt: input.text, workspaceDir: input.workspaceDir });
    await this.insertMessage(input.projectId, turnId, 'user', input.text);
    // Mid-Turn-Steering (Phase C): Gegenwart statt aufgeschobener Wunsch —
    // abgebrochen wird, was JETZT aktiv ist, mit der eigenen neuen turnId als
    // Ausnahme. Hat die Pump die neue Nachricht während des insertMessage-
    // awaits schon selbst gestartet, ist sie der aktive Turn und der Abbruch
    // ein No-op. Die Queue bleibt erhalten.
    if (input.interrupt === true) {
      this.abortActiveTurn(state, turnId);
    }
    // Kein floating void (F18): ohne Rejection-Handler beendet ein Fehler in
    // der Pump den ganzen Serverprozess.
    this.pump(input.projectId).catch((error: unknown) => {
      console.error(`Chat-Pump für ${input.projectId} abgebrochen:`, error);
    });
  }

  /**
   * Re-Entry-Resume (#34): Stirbt der Host (Release/Neustart) oder die Sandbox,
   * während ein Turn läuft, ist die User-Nachricht schon persistiert, aber die
   * Antwort nie — und der In-Memory-Zustand ist danach leer. Die letzte
   * Chat-Zeile ist dann eine unbeantwortete User-Nachricht: das zuverlässige,
   * persistente Signal für einen gestorbenen Turn. Beim Wieder-Öffnen des
   * Projekts wird GENAU dieser Prompt automatisch erneut ausgeführt — für den
   * User mehr oder weniger dasselbe Ergebnis, ohne erneutes Tippen.
   *
   * Bewusst konservativ:
   * - Nur wenn die letzte Zeile `role === 'user'` hat. Hat der Turn schon etwas
   *   Terminales geschrieben (assistant-Antwort, error, „Turn abgebrochen" nach
   *   Nutzer-Stop), wird NICHT wiederaufgenommen — sonst drohten Doppel-Antworten
   *   bzw. partielle Duplikate.
   * - Guard gegen Doppellauf: läuft/wartet im selben Prozess schon ein Turn,
   *   passiert nichts.
   * - Re-Enqueue mit der ORIGINALEN turnId, OHNE neue User-Zeile (kein
   *   insertMessage) — sonst entstünde bei jedem Host-Neustart ein Duplikat der
   *   User-Bubble. Die Antwortzeilen gruppieren sich über die wiederverwendete
   *   turnId unter derselben Bubble.
   *
   * `resumeSessionId` wird nicht übergeben — `runAttempt` liest es pro Versuch
   * frisch aus der Projektzeile (`projects.claudeSessionId` + Modellabgleich).
   *
   * Owner-only, und die Prüfung hängt HIER am Service (M5): sie greift damit
   * für jeden Aufrufer, nicht nur für den enterProject-Resolver — ein Resume
   * reiht einen VOLLEN Agent-Turn ein, inklusive Auto-Commit am Ende. Aber
   * als FEATURE-GATING, nicht als Authz-Ablehnung: ein Besucher bekommt
   * schlicht kein Resume (stille Rückkehr mit false, kein Wurf). Ein Wurf
   * wäre falsch — er machte enterProject für Nur-Lese-Besucher (R10) kaputt,
   * und „nichts Eigenes wiederaufzunehmen" ist kein Fehler.
   *
   * @returns true, wenn ein Turn wiederaufgenommen wurde.
   */
  async resumeUnansweredTurn(
    user: UserRow,
    projectId: string,
    workspaceDir: string,
  ): Promise<boolean> {
    // Früher Guard nur als billiger Kurzschluss — er allein genügt NICHT.
    if (this.isTurnActive(projectId)) return false;
    // Feature-Gating (s. o.): fremdes oder unbekanntes Projekt → still false.
    // VOR listMessages und VOR dem lazy state() — kein DB-Lesen der Historie
    // und kein liegenbleibender State-Eintrag für fremde Projekte.
    const project = await getProject(this.db, projectId);
    if (project === null || project.ownerId !== user.id) return false;
    const history = await this.listMessages(projectId);
    // Re-Check NACH dem await (check-then-act-Race): zwei gleichzeitige
    // enterProject-Aufrufe des Owners (zwei Tabs; im Dev-Modus der React-
    // StrictMode-Doppel-Effekt) passieren sonst BEIDE den Guard oben, warten
    // beide auf die DB und reihen denselben Turn (originale turnId) doppelt
    // ein — doppelte Agent-Arbeit, doppelte Antwort-Zeilen, zwei Auto-Commits.
    // Zwischen diesem Re-Check und dem queue.push liegt KEIN await mehr: der
    // erste Gewinner macht seinen Push bzw. `pumpRunning` (pump setzt es
    // synchron vor dem ersten await) sofort sichtbar, der zweite sieht hier
    // isTurnActive === true.
    if (this.isTurnActive(projectId)) return false;
    const lastRow = history[history.length - 1];
    if (lastRow === undefined || lastRow.role !== 'user') return false;
    const state = this.state(projectId);
    state.queue.push({ turnId: lastRow.turnId, prompt: lastRow.content, workspaceDir });
    // Kein floating void (F18): ohne Rejection-Handler beendet ein Fehler in
    // der Pump den ganzen Serverprozess.
    this.pump(projectId).catch((error: unknown) => {
      console.error(`Chat-Pump für ${projectId} abgebrochen:`, error);
    });
    return true;
  }

  /** Systemseitige Nachricht in Historie + Stream (z. B. Auto-Commit-Fehler, R8). */
  async postMessage(
    projectId: string,
    role: ChatMessageRow['role'],
    content: string,
  ): Promise<void> {
    await this.insertMessage(projectId, crypto.randomUUID(), role, content);
  }

  /**
   * Bricht den JETZT aktiven Turn ab und leert die Warteschlange (Stop-Button, R6).
   *
   * „Stop heißt Stop" — der Abbruch wirkt auf die Gegenwart und erzeugt keine
   * Verpflichtung, die in die Zukunft reist:
   *
   * 1. **Der abgebrochene Turn wird NICHT wiederholt.** Der Retry in `runTurn`
   *    ist für msb-Flakes gedacht; ein vom Nutzer veranlasster Abbruch ist
   *    keiner. Sonst liefe genau die Arbeit weiter, die er gerade gestoppt hat
   *    — inklusive Dateiänderungen und Auto-Commit.
   * 2. **Auch ein gerade erst STARTENDER Turn wird getroffen** — einer, den
   *    die Pump schon aus der Queue genommen hat, dessen Handle aber noch
   *    nicht steht (Config-Warmup, DB-Abfrage). Der Abbruch pinnt sich an
   *    GENAU dessen turnId; `runAttempt` löst ihn beim Handle-Setzen ein.
   * 3. **Läuft und startet gar nichts, ist der Aufruf ein No-op.** Es wird
   *    nichts vorgemerkt: ein Stop ins Leere (Doppelklick, veralteter
   *    `turnActive`-Stand im Client) darf keine später gesendete, unabhängige
   *    Nachricht abbrechen.
   *
   * Stoppen ist Owner-only (R10) und die Prüfung hängt HIER am Service (M5).
   * Das await davor ändert das Gegenwartsmodell nicht: dasselbe Fenster lag
   * vorher zwischen der Ownership-Prüfung des Resolvers und dem damals
   * synchronen Abbruch — und `abortActiveTurn` pinnt sich ohnehin an das, was
   * IM MOMENT des Abbruchs aktiv ist, nie an „irgendeinen nächsten" Turn.
   */
  async stopTurn(user: UserRow, projectId: string): Promise<void> {
    await getProjectOwned(this.db, user, projectId);
    const state = this.state(projectId);
    state.queue.length = 0;
    this.abortActiveTurn(state, null);
  }

  /**
   * Bricht den JETZT aktiven Turn ab — synchron, ohne aufgeschobenen Wunsch.
   *
   * - Handle steht: sofort über das UMHÜLLTE Handle abbrechen (setzt
   *   `benutzerAbbruch` in `runAttempt` → kein Retry).
   * - Turn startet gerade (`activeTurnId` gesetzt, Handle fehlt noch): Abbruch
   *   an GENAU diese turnId pinnen; `runAttempt` löst ihn beim Handle-Setzen
   *   ein. Weil der Pin die AKTUELLE turnId trägt (nie „den nächsten"), kann
   *   er keine später gestartete Nachricht treffen.
   * - Nichts aktiv: No-op — nichts zu stoppen heißt, es passiert nichts.
   *
   * `ausnahmeTurnId` nimmt genau einen Turn aus (die eigene neue Nachricht
   * eines Interrupts): ist ausgerechnet SIE der aktive Turn, passiert nichts.
   */
  private abortActiveTurn(state: ProjectChatState, ausnahmeTurnId: string | null): void {
    if (state.activeTurnId === null || state.activeTurnId === ausnahmeTurnId) return;
    if (state.currentHandle !== null) {
      // Invariante: currentHandle gehört immer zum Turn mit activeTurnId.
      state.currentHandle.abort();
      return;
    }
    state.abortActiveTurnId = state.activeTurnId;
  }

  /**
   * Vergisst den Zustand eines Projekts — für gelöschte Projekte.
   *
   * Ohne das blieben Queue, Subscriber und `currentHandle` für die Lebensdauer
   * des Prozesses liegen. Ein laufender Turn wird abgebrochen: er schriebe
   * sonst weiter in ein Projekt, das es nicht mehr gibt, samt Auto-Commit in
   * dessen Branch.
   */
  forget(projectId: string): void {
    const state = this.states.get(projectId);
    if (state === undefined) return;
    state.queue.length = 0;
    state.currentHandle?.abort();
    state.subscribers.clear();
    this.states.delete(projectId);
    this.warmups.delete(projectId);
  }

  /** Wie viele Projekte im Speicher gehalten werden (die Zahl hinter dem Leck). */
  trackedProjects(): number {
    return this.states.size;
  }

  /** Live-Stream aller Chat-Events eines Projekts (auch für Nur-Lese-Besucher, R10). */
  subscribe(projectId: string): AsyncIterableIterator<ChatEventPayload> {
    const state = this.state(projectId);
    const buffer: ChatEventPayload[] = [];
    let notify: (() => void) | null = null;
    let closed = false;

    const push = (payload: ChatEventPayload): void => {
      buffer.push(payload);
      notify?.();
    };
    state.subscribers.add(push);

    const iterator: AsyncIterableIterator<ChatEventPayload> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async (): Promise<IteratorResult<ChatEventPayload>> => {
        while (buffer.length === 0 && !closed) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
        const value = buffer.shift();
        if (value !== undefined) {
          return { value, done: false };
        }
        return { value: undefined, done: true };
      },
      return: async (): Promise<IteratorResult<ChatEventPayload>> => {
        closed = true;
        state.subscribers.delete(push);
        notify?.();
        return { value: undefined, done: true };
      },
    };
    return iterator;
  }

  private publish(projectId: string, message: ChatMessageRow, turnActive: boolean): void {
    // Bewusst states.get statt state(): ein noch auslaufender Turn eines
    // GELÖSCHTEN Projekts (forget() hat den State entfernt) darf hier keinen
    // frischen, leeren State neu anlegen — sonst kehrt das gerade behobene Leck
    // zurück. Ohne State gibt es keine Subscriber, an die zu senden wäre.
    const state = this.states.get(projectId);
    if (!state) return;
    for (const subscriber of state.subscribers) {
      subscriber({ message, turnActive });
    }
  }

  private async insertMessage(
    projectId: string,
    turnId: string,
    role: ChatMessageRow['role'],
    content: string,
    turnActive?: boolean,
  ): Promise<ChatMessageRow> {
    // Zweiter Riegel gegen zu lange Inhalte: MAX_MESSAGE_CHARS griff nur im
    // Append-Pfad (appendDelta), nicht hier. Damit kam jede Nicht-Delta-Quelle
    // — insbesondere tool-use/error aus der untrusted VM — am Deckel vorbei.
    // Die Protokoll-Schicht begrenzt die Felder schon; das hier ist die
    // Absicherung an der Senke, damit kein künftiger Pfad sie umgeht.
    const gekuerzt =
      content.length > MAX_MESSAGE_CHARS ? `${content.slice(0, MAX_MESSAGE_CHARS)}…` : content;
    const inserted = await this.db
      .insert(chatMessages)
      .values({ id: crypto.randomUUID(), projectId, turnId, role, content: gekuerzt })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error('Chat-Insert lieferte keine Zeile zurück');
    }
    this.publish(projectId, row, turnActive ?? this.isTurnActive(projectId));
    return row;
  }

  private async pump(projectId: string): Promise<void> {
    const state = this.state(projectId);
    if (state.pumpRunning) return;
    state.pumpRunning = true;
    try {
      let turn = state.queue.shift();
      while (turn) {
        // Synchroner Aktiv-Marker: gesetzt, BEVOR der erste await in
        // runTurn/runAttempt kommt. Ein Stop/Interrupt im Startfenster (Handle
        // fehlt noch) pinnt sich damit an GENAU diese turnId — nie an
        // „irgendeinen nächsten" Turn.
        state.activeTurnId = turn.turnId;
        try {
          await this.runTurn(projectId, turn);
        } finally {
          // Nichts überlebt das Turn-Ende: weder der Aktiv-Marker noch ein
          // nicht eingelöster Abbruch-Pin (er gehörte zu DIESEM Turn).
          state.activeTurnId = null;
          state.abortActiveTurnId = null;
        }
        turn = state.queue.shift();
      }
    } finally {
      state.pumpRunning = false;
    }
  }

  /**
   * Führt einen Turn aus — mit höchstens EINEM Wiederholungsversuch.
   *
   * Die Retry-Politik ist der Kern dieser Methode und gilt als Vertrag
   * gegenüber `stopTurn` und `sendMessage(interrupt)`:
   *
   * - Wiederholt wird nur ein **Flake**: ein Versuch, der weder abgeschlossen
   *   ist noch ein einziges sinnvolles Lebenszeichen geliefert hat. Das ist der
   *   Fall, in dem `msb exec` stirbt oder nie Output liefert.
   * - **Nach einem Nutzerabbruch wird NIE wiederholt** (`benutzerAbbruch` aus
   *   `runAttempt`). Ein Stop, der den Turn gleich darauf erneut ausführt, wäre
   *   das Gegenteil dessen, was der Nutzer wollte — der Agent schriebe Dateien
   *   und committete sie.
   * - Der Wiederholungsversuch startet bewusst OHNE Session-Resume: hing der
   *   erste an einer korrupten Sitzung, heilt der frische Start das. Sonst
   *   resumte jeder Turn dieselbe kaputte Sitzung und hinge endlos.
   */
  private async runTurn(projectId: string, turn: QueuedTurn): Promise<void> {
    // Bewusst states.get statt state() (Leck-Klasse wie in `publish`): nach
    // einem forget() — Projekt gelöscht — darf hier kein frischer, leerer
    // State entstehen, der für die Prozesslebensdauer liegen bliebe. Das
    // VOR einem etwaigen forget() geholte Objekt darf lokal weiterbenutzt
    // werden; nur NEU anlegen ist verboten.
    const state = this.states.get(projectId);
    if (state === undefined) return;
    // msb exec ist gelegentlich flaky: die Exec-Session stirbt oder liefert nie
    // Output. Liefert ein Versuch KEIN einziges sinnvolles Event, wird er genau
    // einmal wiederholt (transparent per Systemzeile) — erst dann Fehler.
    const maxAttempts = 2;
    let lastRow: ChatMessageRow | null = null;
    let completed = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Der Retry startet bewusst OHNE Session-Resume: hing der erste Versuch an
      // einer korrupten/abgebrochenen Session (z. B. nach Interrupt durch neuen
      // Prompt), heilt der frische Start das — sonst resumt jeder Turn dieselbe
      // kaputte Session und hängt endlos.
      const allowResume = attempt === 1;
      const result = await this.runAttempt(projectId, turn, attempt === maxAttempts, allowResume);
      if (result.lastRow !== null) lastRow = result.lastRow;
      completed = result.completed;
      // Ein Nutzerabbruch beendet den Turn endgültig: ihn zu wiederholen hiesse,
      // genau die Arbeit auszuführen, die der Nutzer gerade gestoppt hat.
      if (result.completed || result.sawMeaningful || result.benutzerAbbruch) break;
      // Wurde das Projekt ZWISCHEN den Versuchen per forget() gelöscht, endet
      // der Turn hier sauber: kein Retry, keine „zweiter Versuch"-Zeile — das
      // Projekt existiert nicht mehr. (Sonst legte der nächste runAttempt über
      // state() auch noch einen frischen State an — das Leck.)
      if (!this.states.has(projectId)) return;
      if (attempt < maxAttempts) {
        lastRow = await this.insertMessage(
          projectId,
          turn.turnId,
          'system',
          'Der Agent-Prozess hat nicht reagiert — zweiter Versuch …',
        );
      }
    }

    // Turn-Ende IMMER signalisieren (turnActive = ob noch etwas in der Queue ist),
    // sonst bleibt der Client auf "Agent arbeitet" hängen (Regression 2026-07-04).
    if (lastRow !== null) {
      this.publish(projectId, lastRow, state.queue.length > 0);
    }
    if (completed) {
      await this.hooks.onTurnEnd?.(projectId, turn.prompt);
    }
  }

  /**
   * Stellt dem Prompt den bisherigen Gesprächsverlauf voran, falls es einen gibt
   * (nur user/assistant, gekappt). Nur nötig, wenn OHNE `--resume` gestartet wird
   * — sonst würde der Agent den Kontext der Konversation nicht kennen.
   */
  private async withHistoryContext(
    projectId: string,
    currentTurnId: string,
    prompt: string,
  ): Promise<string> {
    // Nur user/assistant-Zeilen laden — und das Filtern schon in die DB legen,
    // NICHT erst danach. Sonst füllt ein tool-lastiger Turn die geholten Zeilen
    // mit `tool`/`system`/`error` und nach dem Filter bleibt fast nichts (im
    // schlimmsten Fall nichts) übrig: der Agent startete dann ohne Resume UND
    // ohne Kontext und beantwortete ein „weiter" gedächtnislos.
    const convo = (
      await this.db
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.projectId, projectId),
            ne(chatMessages.turnId, currentTurnId),
            inArray(chatMessages.role, ['user', 'assistant']),
          ),
        )
        .orderBy(desc(sql`rowid`))
        .limit(30)
    ).reverse();
    if (convo.length === 0) return prompt;
    const MAX_CHARS = 8_000;
    let verlauf = convo
      .slice(-30)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');
    if (verlauf.length > MAX_CHARS) verlauf = `…\n\n${verlauf.slice(-MAX_CHARS)}`;
    return (
      'Bisheriger Gesprächsverlauf dieses Projekts (der Sitzungskontext wurde ' +
      'nach einem Abbruch neu aufgebaut; der aktuelle Stand des Codes liegt in ' +
      `den Dateien im Workspace):\n\n${verlauf}\n\n---\n\nAktuelle Aufgabe:\n${prompt}`
    );
  }

  /**
   * Ein einzelner Anlauf eines Turns: Runner starten, Events verarbeiten,
   * Watchdog fahren.
   *
   * Der Rückgabewert ist die Entscheidungsgrundlage für den Retry in
   * `runTurn`. Besonders `benutzerAbbruch` gehört zum Vertrag: Er unterscheidet
   * den Abbruch DURCH DEN NUTZER (Stop-Button, Steering) vom Abbruch durch den
   * WATCHDOG (stiller Hänger). Nur letzterer darf wiederholt werden.
   *
   * Umgesetzt ist die Unterscheidung ohne zusätzlichen Zustand: nach aussen —
   * also über `state.currentHandle` — ist nur ein umhülltes Handle erreichbar,
   * dessen `abort()` den Nutzerabbruch vermerkt. Der Watchdog weiter unten
   * greift bewusst auf das ROHE Handle zu.
   *
   * ⚠️ Wer hier eine weitere Abbruchstelle einbaut, muss dieselbe Wahl treffen:
   * `handle.abort()` heisst „Nutzer wollte das, kein Retry", `rohHandle.abort()`
   * heisst „technischer Abbruch, Retry erlaubt". Ein Griff zum falschen Handle
   * schaltet den Retry für echte Hänger still ab.
   */
  private async runAttempt(
    projectId: string,
    turn: QueuedTurn,
    isLastAttempt: boolean,
    allowResume: boolean,
  ): Promise<{
    completed: boolean;
    sawMeaningful: boolean;
    lastRow: ChatMessageRow | null;
    /** Vom Nutzer abgebrochen (Stop/Steering) — kein Flake, also kein Retry. */
    benutzerAbbruch: boolean;
  }> {
    // Bewusst states.get statt state() (Leck-Klasse wie in `publish`): wurde
    // das Projekt zwischen zwei Versuchen per forget() gelöscht, legte das
    // lazy-anlegende state() hier einen leeren State-Eintrag an, der für die
    // Prozesslebensdauer liegen bliebe. Ohne State ist der Versuch
    // gegenstandslos: sauber beenden — kein Retry (benutzerAbbruch wirkt wie
    // beim Nutzer-Stop endgültig), keine neuen Zeilen, kein onTurnEnd.
    const state = this.states.get(projectId);
    if (state === undefined) {
      return { completed: false, sawMeaningful: false, lastRow: null, benutzerAbbruch: true };
    }

    // Läuft ein Config-Warmup, erst darauf warten — sonst konkurrieren zwei
    // claude-exec-Sessions in der VM (microsandbox serialisiert sie → langsam).
    const warmup = this.warmups.get(projectId);
    if (warmup) {
      await warmup;
    }

    const projectRow = (
      await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
    )[0];

    // Modell PRO PROJEKT (Dropdown im Chat); langsame lokale Modelle bekommen
    // großzügigere Timeouts, sonst bricht der Watchdog mitten im „Denken" ab.
    const model = projectRow?.agentModel ?? DEFAULT_AGENT_MODEL;
    const timeouts = agentTimeoutsFor(
      model,
      {
        idleMs: this.idleTimeoutMs,
        firstEventMs: this.firstEventTimeoutMs,
        coldStartMs: this.coldStartTimeoutMs,
      },
      {
        idleMs: this.slowIdleTimeoutMs,
        firstEventMs: this.slowFirstEventTimeoutMs,
        coldStartMs: this.slowColdStartTimeoutMs,
      },
    );
    // Nur fortsetzen, wenn die Session mit dem AKTUELLEN Projekt-Modell erstellt
    // wurde. Sonst (anderes/kein Modell) frisch starten — ein --resume über einen
    // Modellwechsel hinweg bringt Claude Code zum Hängen ("Agent arbeitet" ewig).
    const canResume =
      allowResume && projectRow?.claudeSessionId != null && projectRow.claudeSessionModel === model;
    // Kaltstart: erster Turn dieser (frischen) VM — mehr Zeit bis zum ersten Event.
    const firstEventBudget = canResume ? timeouts.firstEventMs : timeouts.coldStartMs;
    // Kontext-Recovery: OHNE Resume sähe claude nur den neuen Prompt (z. B. nur
    // „weiter"). Gibt es schon einen Chat-Verlauf (nach Interrupt-Reset oder
    // heilendem Retry), betten wir ihn in den Prompt ein — sonst startet der
    // Agent gedächtnislos. Mit Resume trägt --resume den Kontext, dann nicht.
    const prompt = canResume
      ? turn.prompt
      : await this.withHistoryContext(projectId, turn.turnId, turn.prompt);
    const rohHandle = this.runner.startTurn({
      projectId,
      prompt,
      workspaceDir: turn.workspaceDir,
      resumeSessionId: canResume ? projectRow.claudeSessionId : null,
      model,
    });
    // Ein vom NUTZER ausgelöster Abbruch (Stop-Button, Steering) ist kein
    // msb-Flake und darf deshalb keinen zweiten Durchlauf auslösen. Von aussen
    // ist nur dieses umhüllte Handle erreichbar (state.currentHandle), der
    // Watchdog unten greift bewusst auf rohHandle zu — so bleiben die beiden
    // Abbruchgründe unterscheidbar, ohne zusätzlichen Zustand.
    let benutzerAbbruch = false;
    const handle: TurnHandle = {
      events: rohHandle.events,
      /**
       * Abbruch DURCH DEN NUTZER (Stop-Button, Steering) — beendet den Turn
       * endgültig, `runTurn` wiederholt ihn nicht.
       *
       * Das ist die einzige Stelle, an der `benutzerAbbruch` gesetzt wird, und
       * dieses umhüllte Handle ist das einzige, das nach aussen gelangt
       * (`state.currentHandle`). Der Watchdog weiter unten ruft bewusst
       * `rohHandle.abort()` — ein stiller Hänger ist genau der Fall, für den
       * der Retry existiert.
       */
      abort: () => {
        benutzerAbbruch = true;
        rohHandle.abort();
      },
    };
    // Ab hier ist der Turn von aussen abbrechbar — und zwar nur über das
    // umhüllte Handle.
    state.currentHandle = handle;
    // Ein Stop/Interrupt, der im Startfenster DIESES Turns ankam (aktiv, aber
    // Handle stand noch nicht), ist an genau diese turnId gepinnt — jetzt, wo
    // das Handle steht, wird er eingelöst. Bewusst über das UMHÜLLTE Handle:
    // das setzt `benutzerAbbruch`, also kein Retry. Ein Pin auf eine fremde
    // turnId kann hier nicht auftauchen — die Pump räumt ihn spätestens am
    // Ende seines Turns.
    if (state.abortActiveTurnId === turn.turnId) {
      state.abortActiveTurnId = null;
      handle.abort();
    }

    let assistantRow: ChatMessageRow | null = null;
    let thinkingRow: ChatMessageRow | null = null;
    // Zuletzt gesendete Zeile — damit das Turn-Ende IMMER signalisiert werden kann,
    // auch wenn der Turn mit einem Tool-Call endet (sonst hängt "Agent arbeitet").
    let lastRow: ChatMessageRow | null = null;
    let completed = false;
    // Kam irgendein sinnvolles Lebenszeichen (alles außer error/turn-aborted)?
    // Wenn nicht, war der Start ein msb-Flake und darf wiederholt werden.
    let sawMeaningful = false;
    let sawAnyEvent = false;

    const insert = async (
      role: ChatMessageRow['role'],
      content: string,
    ): Promise<ChatMessageRow> => {
      lastRow = await this.insertMessage(projectId, turn.turnId, role, content);
      return lastRow;
    };

    // Streamt ein Delta in die laufende Zeile der jeweiligen Rolle (assistant/thinking).
    const appendDelta = async (
      current: ChatMessageRow | null,
      role: ChatMessageRow['role'],
      text: string,
    ): Promise<ChatMessageRow> => {
      if (current === null) {
        return insert(role, text);
      }
      // Deckel gegen unbegrenztes Wachstum (F16): ein kompromittierter Daemon
      // könnte sonst Speicher, Platte und alle SSE-Abonnenten sättigen. Die
      // Zeile wird abgeschlossen und eine neue begonnen — der Stream bricht
      // nicht ab, der Inhalt bleibt vollständig.
      if (current.content.length + text.length > MAX_MESSAGE_CHARS) {
        return insert(role, text);
      }
      const updated: ChatMessageRow = { ...current, content: current.content + text };
      await this.db
        .update(chatMessages)
        .set({ content: updated.content })
        .where(eq(chatMessages.id, updated.id));
      this.publish(projectId, updated, true);
      lastRow = updated;
      return updated;
    };

    const iterator = handle.events[Symbol.asyncIterator]();
    // Genau EIN laufendes next() teilen — sonst geht bei einem Timeout das gerade
    // schwebende Event verloren (der spätere Fehlertext läge im verworfenen next()).
    let pending = iterator.next();
    const race = async (timeoutMs: number): Promise<IteratorResult<AgentEvent> | 'timeout'> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        return await Promise.race([pending, timeoutP]);
      } finally {
        clearTimeout(timer);
      }
    };
    // Nach dem Abbruch: kurz weiterlesen und einen etwaigen Fehlertext einsammeln.
    const drainForErrorDetail = async (): Promise<string> => {
      const deadline = Date.now() + this.abortGraceMs;
      const parts: string[] = [];
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const step = await race(remaining);
        if (step === 'timeout') break;
        pending = iterator.next();
        if (step.done) break;
        if (step.value.type === 'error') parts.push(step.value.message);
      }
      return parts.join('\n');
    };
    const handleEvent = async (event: AgentEvent): Promise<void> => {
      this.hooks.onAgentActivity?.(projectId);
      sawAnyEvent = true;
      if (event.type !== 'error' && event.type !== 'turn-aborted') {
        sawMeaningful = true;
      }
      switch (event.type) {
        case 'text-delta':
          assistantRow = await appendDelta(assistantRow, 'assistant', event.text);
          break;
        case 'thinking-delta':
          // Denken live in eine eigene Zeile streamen (falls die API es liefert).
          thinkingRow = await appendDelta(thinkingRow, 'thinking', event.text);
          break;
        case 'tool-use':
          // Neuer Tool-Call beginnt: die laufende Text-/Denk-Bubble ist zu Ende.
          assistantRow = null;
          thinkingRow = null;
          await insert('tool', event.detail ? `${event.name}: ${event.detail}` : event.name);
          break;
        case 'block-stop':
          // Blockgrenze: die nächste Text-/Denk-Sequenz startet eine neue Bubble.
          assistantRow = null;
          thinkingRow = null;
          break;
        case 'session':
          // Session-ID früh sichern — überlebt auch einen abgebrochenen Turn (R9).
          // Modell mitschreiben: ein späterer Modellwechsel darf diese Session
          // NICHT fortsetzen (--resume + anderes --model hängt).
          await this.db
            .update(projects)
            .set({ claudeSessionId: event.sessionId, claudeSessionModel: model })
            .where(eq(projects.id, projectId));
          break;
        case 'api-retry':
          // Sichtbar machen (R6) — aber nur einmal pro Turn, kein Retry-Spam.
          if (event.attempt === 1) {
            await insert(
              'system',
              `Claude-API-Störung: ${event.message} — automatische Wiederholung läuft (max. ${event.maxRetries} Versuche)`,
            );
          }
          break;
        case 'error':
          await insert('error', event.message);
          break;
        case 'turn-aborted':
          // Stiller Flake-Abbruch (nichts Sinnvolles passiert, Retry folgt):
          // keine verwirrende „Turn abgebrochen"-Zeile posten. Beim
          // Nutzerabbruch folgt kein Retry, also ist dieser Versuch der letzte
          // — die Rückmeldung MUSS dann sichtbar sein.
          if (benutzerAbbruch || sawMeaningful || isLastAttempt) {
            await insert('system', 'Turn abgebrochen');
          }
          break;
        case 'turn-completed':
          completed = true;
          if (event.sessionId !== null) {
            await this.db
              .update(projects)
              .set({ claudeSessionId: event.sessionId, claudeSessionModel: model })
              .where(eq(projects.id, projectId));
          }
          break;
      }
    };

    try {
      for (;;) {
        // Vor dem ersten Event gilt der kurze Start-Timeout (kaputter msb-exec
        // wird in Sekunden erkannt), danach der großzügige Idle-Timeout.
        const step = await race(sawAnyEvent ? timeouts.idleMs : firstEventBudget);
        if (step === 'timeout') {
          // Stiller Hänger: abbrechen. Beim letzten Versuch als Fehler SICHTBAR
          // machen (statt ewig „Agent arbeitet"); sonst folgt gleich der Retry.
          // Bewusst rohHandle: DAS hier ist der Watchdog, kein Nutzerabbruch —
          // ein Hänger ist genau der Fall, für den der Retry gedacht ist.
          rohHandle.abort();
          const detail = await drainForErrorDetail();
          if (benutzerAbbruch) {
            // Nutzer-Stop, aber der Runner hat sein turn-aborted nie geliefert
            // (z. B. Daemon nie verbunden, M1): Terminal-Zeile trotzdem
            // schreiben — sonst bliebe die letzte Zeile die User-Nachricht
            // (resumeUnansweredTurn führte den gerade gestoppten Prompt beim
            // nächsten Öffnen erneut aus) und mangels lastRow würde
            // turnActive:false nie publiziert („Agent arbeitet" für immer).
            // Gleiches Vokabular wie der turn-aborted-Pfad, EIN Stop-Bild im UI.
            await insert('system', 'Turn abgebrochen');
          } else if (sawMeaningful || isLastAttempt) {
            const usedMs = sawAnyEvent ? timeouts.idleMs : firstEventBudget;
            const secs = Math.round(usedMs / 1000);
            await insert(
              'error',
              `Der Agent hat ${secs}s lang nicht reagiert und wurde abgebrochen.` +
                (detail
                  ? `\n\n${detail}`
                  : ' Kein weiterer Fehlertext verfügbar — mögliche Ursache: die Claude-API ' +
                    'antwortet nicht (Netz-/Rate-Limit-Problem).'),
            );
          }
          break;
        }
        pending = iterator.next();
        if (step.done) break;
        await handleEvent(step.value);
      }
    } catch (error) {
      // Runner-Fehler nie verschlucken — als error-Zeile in die Historie.
      // Der Insert selbst darf aber NICHT werfen (F18): wurde das Projekt
      // während des Turns gelöscht, scheitert er am Fremdschlüssel, und die
      // Exception entkäme über die floating pump() als Unhandled Rejection.
      try {
        await insert('error', error instanceof Error ? error.message : String(error));
      } catch (insertError) {
        console.error(
          `Fehlermeldung für ${projectId} konnte nicht gespeichert werden (Projekt gelöscht?):`,
          insertError,
        );
      }
    } finally {
      state.currentHandle = null;
    }

    return { completed, sawMeaningful, lastRow, benutzerAbbruch };
  }
}
