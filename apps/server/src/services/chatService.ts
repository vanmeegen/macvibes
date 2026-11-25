import type { AgentRunner, TurnHandle } from '../agent/runner';
import type { Db } from '../db/client';
import type { ChatMessageRow, UserRow } from '../db/schema';
import { ChatEventBus, type ChatEventPayload } from './chat/chatEventBus';
import { ChatMessageStore, MAX_MESSAGE_CHARS } from './chat/chatMessageStore';
import { ConfigWarmup } from './chat/configWarmup';
import {
  TurnAttempt,
  abortedText,
  type AttemptTurn,
  type TurnAttemptDeps,
  type TurnAttemptResult,
} from './chat/turnAttempt';
import { getProject, getProjectOwned } from './projectsService';

export { MAX_MESSAGE_CHARS };
export type { ChatEventPayload } from './chat/chatEventBus';

export interface ChatHooks {
  /** Für den Idle-Timer der Sandbox (R9). */
  onAgentActivity?: (projectId: string) => void;
  /** Nach jedem abgeschlossenen Turn — Auto-Commit (R8, B4). */
  onTurnEnd?: (projectId: string, userPrompt: string) => Promise<void>;
  /**
   * Ist der Agent-Daemon der Sandbox gerade mit dem Host verbunden? Nur für
   * die Wortwahl der Fehlzeile nach einem Hänger (A1). Fehlt der Hook, gilt
   * der Agent als erreichbar.
   */
  isAgentReachable?: (projectId: string) => boolean;
}

export interface SendMessageInput {
  projectId: string;
  workspaceDir: string;
  text: string;
  /** Mid-Turn-Steering (Phase C): laufenden Turn abbrechen und neu ansetzen. */
  interrupt?: boolean;
}

type QueuedTurn = AttemptTurn;

interface ProjectChatState {
  queue: QueuedTurn[];
  pumpRunning: boolean;
  /**
   * Handle des laufenden Turns — das UMHÜLLTE aus `TurnAttempt`, nicht das des
   * Runners. Sein `abort()` markiert den Turn als Nutzerabbruch und beendet ihn
   * damit endgültig (kein Retry). Genau dafür liegt hier der Wrapper: der
   * Watchdog in `TurnAttempt` hat das rohe Handle und bricht ohne diese Wirkung
   * ab.
   */
  currentHandle: TurnHandle | null;
  /**
   * Die turnId, die die Pump GERADE verarbeitet — gesetzt, BEVOR der erste
   * await in `runTurn`/`runAttempt` kommt, geräumt, wenn der Turn endet. Sie
   * macht das Startfenster sichtbar, in dem ein Turn AKTIV ist, aber sein
   * Handle noch fehlt (Config-Warmup, DB-Abfrage in `TurnAttempt`): ein
   * Stop/Interrupt in diesem Fenster pinnt sich an GENAU diese turnId — nie
   * an „irgendeinen nächsten" Turn.
   */
  activeTurnId: string | null;
  /**
   * „Stop heißt Stop — Gegenwart, kein aufgeschobener Wunsch": Abbruch für den
   * Turn, der beim Stop/Interrupt gerade STARTETE (aktiv, aber noch ohne
   * Handle). Immer eine Kopie von `activeTurnId` im Moment des Abbruchs;
   * `TurnAttempt` löst ihn beim Handle-Setzen ein, wenn die turnId übereinstimmt,
   * und die Pump räumt ihn spätestens am Turn-Ende. Weil er an die AKTUELLE
   * turnId gepinnt ist, kann er keine später gestartete Nachricht treffen.
   */
  abortActiveTurnId: string | null;
}

/**
 * Turn-Fristen, alle optional (undefined = eingebauter Default). Dieselbe Form
 * wie `config.agent.timeouts` — die Config wird unverändert durchgereicht,
 * statt Feld für Feld umbenannt zu werden.
 */
export interface ChatTimeoutOverrides {
  /**
   * Reagiert der Agent so lange gar nicht (kein einziges Event), gilt der Turn
   * als hängend: er wird abgebrochen und der Hänger als Fehler sichtbar gemacht,
   * statt ewig auf „Agent arbeitet" zu stehen.
   */
  idleMs?: number | undefined;
  /**
   * Kommt nach dem Start GAR KEIN Event in dieser Zeit, ist der Start kaputt
   * (claudes init-Zeile kommt sonst in 1–3s) — sofort abbrechen/retryen statt
   * den vollen Idle-Timeout abzuwarten.
   */
  firstEventMs?: number | undefined;
  /**
   * Erster Turn eines Projekts = frisch geforkte VM + claude-First-Run; das
   * dauert deutlich länger als ein Folge-Turn. Für diesen Kaltstart gilt ein
   * großzügigerer First-Event-Timeout (der User sieht derweil „MicroVM startet").
   */
  coldStartMs?: number | undefined;
  /** Frist für den Config-Warmup (Default 60s). */
  warmupMs?: number | undefined;
  /**
   * Varianten für LANGSAME (lokale) Modelle — die denken vor dem ersten
   * sichtbaren Token deutlich länger. Welche Variante greift, entscheidet das
   * Projekt-Modell pro Turn (agentTimeoutsFor).
   */
  slowIdleMs?: number | undefined;
  slowFirstEventMs?: number | undefined;
  slowColdStartMs?: number | undefined;
}

export interface ChatServiceOptions {
  /** Turn-Fristen (MACVIBES_AGENT_*_TIMEOUT_MS über config.agent.timeouts). */
  timeouts?: ChatTimeoutOverrides | undefined;
  /** Nachlauf nach dem Abbruch, um einen späten Fehlertext einzusammeln. */
  abortGraceMs?: number | undefined;
  /**
   * Stillen Config-Warmup beim Projekt-Öffnen ausführen. Default true (Claude).
   * Bei langsamen lokalen Modellen abschalten — der Warmup belegt sonst den
   * Ein-Turn-Daemon und der erste echte Prompt wird abgewiesen.
   */
  prewarmEnabled?: boolean | undefined;
  /**
   * Zeitfenster in ms, in dem Text-/Denk-Deltas gebündelt werden: pro Fenster
   * EIN DB-Update und EIN Event an die Abonnenten statt eines pro Delta
   * (sonst quadratisch in der Antwortlänge). 0 = jedes Delta sofort.
   */
  agentDeltaFlushMs?: number | undefined;
}

export class ChatService {
  private readonly states = new Map<string, ProjectChatState>();
  private readonly bus = new ChatEventBus();
  private readonly store: ChatMessageStore;
  /** Stiller Config-Warmup frisch geforkter VMs (siehe prewarm). */
  private readonly warmup: ConfigWarmup;
  /** Was jeder Turn-Versuch braucht — einmal aufgelöst (Timeouts, Senken). */
  private readonly attemptDeps: TurnAttemptDeps;

  constructor(
    private readonly db: Db,
    runner: AgentRunner,
    private readonly hooks: ChatHooks = {},
    options: ChatServiceOptions = {},
  ) {
    this.store = new ChatMessageStore(db);
    const timeouts = options.timeouts ?? {};
    const idleMs = timeouts.idleMs ?? 180_000;
    const slowIdleMs = timeouts.slowIdleMs ?? 600_000;
    this.attemptDeps = {
      store: this.store,
      runner,
      insertMessage: (projectId, turnId, role, content) =>
        this.insertMessage(projectId, turnId, role, content),
      publish: (projectId, message, turnActive) => this.publish(projectId, message, turnActive),
      onAgentActivity: (projectId) => this.hooks.onAgentActivity?.(projectId),
      isAgentReachable: (projectId) => this.hooks.isAgentReachable?.(projectId) ?? true,
      fastTimeouts: {
        idleMs,
        // Nie länger warten als der Idle-Timeout — der Start-Timeout ist die UNTERE Schranke.
        firstEventMs: Math.min(timeouts.firstEventMs ?? 8_000, idleMs),
        coldStartMs: Math.min(timeouts.coldStartMs ?? 30_000, idleMs),
      },
      slowTimeouts: {
        idleMs: slowIdleMs,
        firstEventMs: Math.min(timeouts.slowFirstEventMs ?? 180_000, slowIdleMs),
        coldStartMs: Math.min(timeouts.slowColdStartMs ?? 300_000, slowIdleMs),
      },
      abortGraceMs: options.abortGraceMs ?? 5_000,
      deltaFlushMs: options.agentDeltaFlushMs ?? 50,
    };
    this.warmup = new ConfigWarmup(this.store, runner, {
      enabled: options.prewarmEnabled ?? true,
      timeoutMs: timeouts.warmupMs ?? 60_000,
      isTurnActive: (projectId) => this.isTurnActive(projectId),
    });
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
      };
      this.states.set(projectId, state);
    }
    return state;
  }

  async listMessages(projectId: string): Promise<ChatMessageRow[]> {
    return this.store.list(projectId);
  }

  /**
   * Läuft (oder startet gleich) ein ECHTER Agent-Turn? Speist GraphQL
   * (Project.turnActive) und damit das UI — „Agent arbeitet", Stop-Button.
   * Der Config-Warmup zählt hier bewusst NICHT: er ist kein Turn, ein Stop
   * auf ihn wäre ein No-op (activeTurnId ist null), und jedes frisch
   * geöffnete Projekt zeigte sonst grundlos „Agent arbeitet".
   */
  isTurnActive(projectId: string): boolean {
    const state = this.states.get(projectId);
    if (!state) return false;
    return state.pumpRunning || state.queue.length > 0 || state.currentHandle !== null;
  }

  /**
   * Ist die Sandbox dieses Projekts BELEGT? Speist den SandboxManager
   * (Grace-Aufschub, Eviction-Schutz). Umfasst neben echten Turns auch den
   * Config-Warmup: der belegt den Ein-Turn-Daemon genauso — Grace/LRU dürfen
   * die VM nicht unter ihm wegstoppen (N9). Der Warmup-Eintrag verschwindet
   * garantiert nach dem Lauf (ConfigWarmup.prewarm) — kein Dauer-busy-Risiko.
   */
  isBusy(projectId: string): boolean {
    return this.warmup.isRunning(projectId) || this.isTurnActive(projectId);
  }

  /**
   * Wärmt die claude-Config einer frisch geforkten VM vor (stiller
   * Wegwerf-Turn beim Öffnen des Projekts). Wirft nie, Owner-only als
   * Feature-Gating — Einzelheiten und Begründungen in `ConfigWarmup.prewarm`.
   */
  prewarm(user: UserRow, projectId: string, workspaceDir: string): Promise<void> {
    return this.warmup.prewarm(user, projectId, workspaceDir);
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
   *   Flakes da (Agent-Start ohne Lebenszeichen); ein vom Nutzer veranlasster Abbruch ist keiner (s.
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
    try {
      await this.insertMessage(input.projectId, turnId, 'user', input.text);
    } catch (error) {
      // Der Push steht bewusst VOR dem Insert (Startfenster-Semantik). Wirft
      // der Insert (SQLITE_BUSY, FK-Verletzung bei gleichzeitigem
      // deleteProject), darf der Eintrag nicht verwaisen: niemand ruft danach
      // pump(), aber `queue.length > 0` hielte isBusy für immer true — die
      // Sandbox wäre nie mehr Grace-/Eviction-Kandidat („Agent arbeitet" ohne
      // Ende). Eintrag zurücknehmen, Fehler sichtbar weiterwerfen.
      const index = state.queue.findIndex((turn) => turn.turnId === turnId);
      if (index !== -1) state.queue.splice(index, 1);
      throw error;
    }
    // Mid-Turn-Steering (Phase C): Gegenwart statt aufgeschobener Wunsch —
    // abgebrochen wird, was JETZT aktiv ist, mit der eigenen neuen turnId als
    // Ausnahme. Hat die Pump die neue Nachricht während des insertMessage-
    // awaits schon selbst gestartet, ist sie der aktive Turn und der Abbruch
    // ein No-op. Die Queue bleibt erhalten.
    if (input.interrupt === true) {
      this.abortActiveTurn(state, turnId);
    }
    this.startPump(input.projectId);
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
   * `resumeSessionId` wird nicht übergeben — `TurnAttempt` liest es pro Versuch
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
    // VOR dem Lesen der letzten Zeile und VOR dem lazy state() — kein DB-Lesen der Historie
    // und kein liegenbleibender State-Eintrag für fremde Projekte.
    const project = await getProject(this.db, projectId);
    if (project === null || project.ownerId !== user.id) return false;
    const lastRow = await this.store.last(projectId);
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
    if (lastRow === undefined || lastRow.role !== 'user') return false;
    const state = this.state(projectId);
    state.queue.push({ turnId: lastRow.turnId, prompt: lastRow.content, workspaceDir });
    this.startPump(projectId);
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
   *    ist für Flakes gedacht (Agent-Start ohne Lebenszeichen); ein vom Nutzer veranlasster Abbruch ist
   *    keiner. Sonst liefe genau die Arbeit weiter, die er gerade gestoppt hat
   *    — inklusive Dateiänderungen und Auto-Commit.
   * 2. **Auch ein gerade erst STARTENDER Turn wird getroffen** — einer, den
   *    die Pump schon aus der Queue genommen hat, dessen Handle aber noch
   *    nicht steht (Config-Warmup, DB-Abfrage). Der Abbruch pinnt sich an
   *    GENAU dessen turnId; `TurnAttempt` löst ihn beim Handle-Setzen ein.
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
    // Verworfene Queue-Einträge merken, BEVOR synchron geleert und abgebrochen
    // wird — das await für ihre Terminal-Zeile kommt erst danach.
    const verworfen = state.queue.splice(0, state.queue.length);
    this.abortActiveTurn(state, null);
    // Auch verworfene, noch nicht gestartete Nachrichten brauchen eine
    // Terminal-Zeile: ihre User-Zeile ist bereits persistiert — bliebe sie die
    // letzte im Chat (der aktive Turn schreibt seine eigene Zeile ggf. VOR ihr
    // oder gar nicht, wenn er längst fertig war und die Pump nur noch im
    // onTurnEnd-Hook hing), führte resumeUnansweredTurn beim nächsten Öffnen
    // GENAU die gestoppte Nachricht stillschweigend aus. Eine Zeile (für den
    // letzten Eintrag) genügt: der Resume schaut nur auf die letzte Zeile.
    const letzter = verworfen[verworfen.length - 1];
    if (letzter !== undefined) {
      await this.insertMessage(projectId, letzter.turnId, 'system', abortedText(false));
    }
  }

  /**
   * Bricht den JETZT aktiven Turn ab — synchron, ohne aufgeschobenen Wunsch.
   *
   * - Handle steht: sofort über das UMHÜLLTE Handle abbrechen (setzt
   *   `userAborted` in `TurnAttempt` → kein Retry).
   * - Turn startet gerade (`activeTurnId` gesetzt, Handle fehlt noch): Abbruch
   *   an GENAU diese turnId pinnen; `TurnAttempt` löst ihn beim Handle-Setzen
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
    this.bus.forget(projectId);
    this.states.delete(projectId);
    this.warmup.forget(projectId);
  }

  /** Wie viele Projekte im Speicher gehalten werden (die Zahl hinter dem Leck). */
  trackedProjects(): number {
    return this.states.size;
  }

  /** Live-Stream aller Chat-Events eines Projekts (auch für Nur-Lese-Besucher, R10). */
  subscribe(projectId: string): AsyncIterableIterator<ChatEventPayload> {
    // Der Projekt-Zustand entsteht wie bisher schon beim Abonnieren (lazy).
    this.state(projectId);
    return this.bus.subscribe(projectId);
  }

  private publish(projectId: string, message: ChatMessageRow, turnActive: boolean): void {
    this.bus.publish(projectId, message, turnActive);
  }

  /**
   * Startet die Pump ohne floating void (F18): ohne Rejection-Handler beendet
   * ein Fehler in der Pump den ganzen Serverprozess.
   */
  private startPump(projectId: string): void {
    this.pump(projectId).catch((error: unknown) => {
      console.error(`Chat-Pump für ${projectId} abgebrochen:`, error);
    });
  }

  private async insertMessage(
    projectId: string,
    turnId: string,
    role: ChatMessageRow['role'],
    content: string,
  ): Promise<ChatMessageRow> {
    const row = await this.store.insert(projectId, turnId, role, content);
    this.publish(projectId, row, this.isTurnActive(projectId));
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
        } catch (error) {
          // Kein Wurf verlässt die Schleife: sonst bliebe die restliche Queue
          // verwaist liegen (isBusy für immer true, „Agent arbeitet" ohne
          // Ende) — die wartenden Nachrichten laufen stattdessen weiter.
          // runTurn fängt seine Kernpfade selbst; hier landen nur Randwürfe
          // (DB-Read vor dem try in TurnAttempt.run, withHistoryContext).
          console.error(`Turn ${turn.turnId} für ${projectId} scheiterte hart:`, error);
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
   *   Fall, in dem der Agent-Start scheitert oder nie ein Event liefert (etwa
   *   weil der Daemon in der VM nicht verbunden ist).
   * - **Nach einem Nutzerabbruch wird NIE wiederholt** (`userAborted` aus
   *   `TurnAttempt`). Ein Stop, der den Turn gleich darauf erneut ausführt, wäre
   *   das Gegenteil dessen, was der Nutzer wollte — der Agent schriebe Dateien
   *   und committete sie.
   * - Der Wiederholungsversuch startet bewusst OHNE Session-Resume: hing der
   *   erste an einer korrupten Sitzung, heilt der frische Start das. Sonst
   *   resumte jeder Turn dieselbe kaputte Sitzung und hinge endlos.
   */
  private async runTurn(projectId: string, turn: QueuedTurn): Promise<void> {
    // Bewusst states.get statt state() (Leck-Klasse wie in `ChatEventBus.publish`): nach
    // einem forget() — Projekt gelöscht — darf hier kein frischer, leerer
    // State entstehen, der für die Prozesslebensdauer liegen bliebe. Das
    // VOR einem etwaigen forget() geholte Objekt darf lokal weiterbenutzt
    // werden; nur NEU anlegen ist verboten.
    const state = this.states.get(projectId);
    if (state === undefined) return;
    // Ein Agent-Start kann flaken: er scheitert oder liefert nie ein Event.
    // Liefert ein Versuch KEIN einziges sinnvolles Event, wird er genau
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
      if (result.completed || result.sawMeaningful || result.userAborted) break;
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
      try {
        await this.hooks.onTurnEnd?.(projectId, turn.prompt);
      } catch (error) {
        // Ein werfender Hook (Auto-Commit: git kaputt, postMessage nach
        // deleteProject) darf die Pump-Schleife nicht sprengen — sonst bleibt
        // die restliche Queue verwaist liegen und isBusy für immer true.
        console.error(`onTurnEnd-Hook für ${projectId} schlug fehl:`, error);
      }
    }
  }

  /**
   * Ein einzelner Anlauf eines Turns. Prüft, ob es das Projekt noch gibt,
   * wartet einen laufenden Config-Warmup ab und übergibt dann an `TurnAttempt`
   * (Runner starten, Events verarbeiten, Watchdog — s. dort, auch zum Vertrag
   * von `userAborted`).
   */
  private async runAttempt(
    projectId: string,
    turn: QueuedTurn,
    isLastAttempt: boolean,
    allowResume: boolean,
  ): Promise<TurnAttemptResult> {
    // Bewusst states.get statt state() (Leck-Klasse wie in `runTurn`): wurde
    // das Projekt zwischen zwei Versuchen per forget() gelöscht, legte das
    // lazy-anlegende state() hier einen leeren State-Eintrag an, der für die
    // Prozesslebensdauer liegen bliebe. Ohne State ist der Versuch
    // gegenstandslos: sauber beenden — kein Retry (userAborted wirkt wie
    // beim Nutzer-Stop endgültig), keine neuen Zeilen, kein onTurnEnd.
    const state = this.states.get(projectId);
    if (state === undefined) {
      return { completed: false, sawMeaningful: false, lastRow: null, userAborted: true };
    }

    // Läuft ein Config-Warmup, erst darauf warten — er belegt den
    // Ein-Turn-Daemon der VM, ein gleichzeitiger echter Turn würde abgewiesen.
    const warmup = this.warmup.pending(projectId);
    if (warmup) {
      await warmup;
    }

    return new TurnAttempt(
      this.attemptDeps,
      state,
      projectId,
      turn,
      isLastAttempt,
      allowResume,
    ).run();
  }
}
