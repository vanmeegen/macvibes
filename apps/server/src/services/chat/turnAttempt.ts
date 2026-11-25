import {
  agentTimeoutsFor,
  defaultAgentModel,
  effectiveAgentModel,
  type AgentTimeouts,
} from '../../agent/agentModel';
import type { AgentEvent } from '../../agent/events';
import type { AgentRunner, TurnHandle } from '../../agent/runner';
import type { ChatMessageRow } from '../../db/schema';
import { MAX_MESSAGE_CHARS, type ChatMessageStore } from './chatMessageStore';

/**
 * Anhang für Terminal-Zeilen, wenn ein Turn NACH sinnvollen Events abbrach:
 * Der Zwischenstand liegt im Workspace, die SDK-Session trägt den Kontext —
 * ein schlichtes „weiter" setzt nahtlos fort. Ohne den Hinweis weiß das
 * niemand; ohne sinnvolle Events gäbe es nichts fortzusetzen (dann weglassen).
 */
const CONTINUE_HINT =
  'Der Zwischenstand bleibt erhalten — mit „weiter" setzt der Agent an dieser Stelle fort.';

/** System-Zeile nach einem Abbruch — mit Weiter-Hinweis, wenn schon Arbeit sichtbar war. */
export function abortedText(sawWork: boolean): string {
  return 'Turn abgebrochen' + (sawWork ? ` — ${CONTINUE_HINT}` : '');
}

/** Der Turn aus der Queue, den dieser Versuch ausführt. */
export interface AttemptTurn {
  turnId: string;
  prompt: string;
  workspaceDir: string;
}

/**
 * Die beiden Felder des Projekt-Zustands, über die ein Versuch von aussen
 * abbrechbar ist (Bedeutung s. ProjectChatState im ChatService).
 */
export interface TurnAbortSlot {
  currentHandle: TurnHandle | null;
  abortActiveTurnId: string | null;
}

export interface TurnAttemptDeps {
  store: ChatMessageStore;
  runner: AgentRunner;
  /** Persistiert eine Zeile UND sendet sie an die Abonnenten. */
  insertMessage: (
    projectId: string,
    turnId: string,
    role: ChatMessageRow['role'],
    content: string,
  ) => Promise<ChatMessageRow>;
  publish: (projectId: string, message: ChatMessageRow, turnActive: boolean) => void;
  /** Für den Idle-Timer der Sandbox (R9). */
  onAgentActivity: (projectId: string) => void;
  /** Timeouts für schnelle bzw. langsame (lokale) Modelle — die Wahl fällt pro Turn. */
  fastTimeouts: AgentTimeouts;
  slowTimeouts: AgentTimeouts;
  /** Nachlauf nach dem Abbruch, um einen späten Fehlertext einzusammeln. */
  abortGraceMs: number;
  /** Bündel-Zeitfenster für Streaming-Deltas (0 = jedes Delta sofort). */
  deltaFlushMs: number;
}

export interface TurnAttemptResult {
  completed: boolean;
  sawMeaningful: boolean;
  lastRow: ChatMessageRow | null;
  /** Vom Nutzer abgebrochen (Stop/Steering) — kein Flake, also kein Retry. */
  userAborted: boolean;
}

/**
 * Ein einzelner Anlauf eines Turns: Runner starten, Events verarbeiten,
 * Watchdog fahren. Eine Instanz pro Versuch — der Zustand des Versuchs lebt in
 * ihren Feldern.
 *
 * Das Ergebnis ist die Entscheidungsgrundlage für den Retry in
 * `ChatService.runTurn`. Besonders `userAborted` gehört zum Vertrag: Es
 * unterscheidet den Abbruch DURCH DEN NUTZER (Stop-Button, Steering) vom
 * Abbruch durch den WATCHDOG (stiller Hänger). Nur letzterer darf wiederholt
 * werden.
 *
 * Umgesetzt ist die Unterscheidung über zwei Handles: nach aussen — also über
 * `slot.currentHandle` — ist nur ein umhülltes Handle erreichbar, dessen
 * `abort()` den Nutzerabbruch vermerkt. Der Watchdog greift bewusst auf das
 * ROHE Handle zu.
 *
 * ⚠️ Wer hier eine weitere Abbruchstelle einbaut, muss dieselbe Wahl treffen:
 * `handle.abort()` heisst „Nutzer wollte das, kein Retry", `rawHandle.abort()`
 * heisst „technischer Abbruch, Retry erlaubt". Ein Griff zum falschen Handle
 * schaltet den Retry für echte Hänger still ab.
 */
export class TurnAttempt {
  private model = defaultAgentModel();
  /** Setzt NUR das umhüllte Handle (s. Klassenkommentar). */
  private userAborted = false;
  private assistantRow: ChatMessageRow | null = null;
  private thinkingRow: ChatMessageRow | null = null;
  /**
   * Zuletzt gesendete Zeile — damit das Turn-Ende IMMER signalisiert werden
   * kann, auch wenn der Turn mit einem Tool-Call endet (sonst hängt „Agent
   * arbeitet").
   */
  private lastRow: ChatMessageRow | null = null;
  private completed = false;
  /**
   * Kam irgendein sinnvolles Lebenszeichen (alles außer error/turn-aborted)?
   * Wenn nicht, war der Start ein Flake und darf wiederholt werden.
   */
  private sawMeaningful = false;
  private sawAnyEvent = false;
  /**
   * Getrennt von sawMeaningful (dem Flake-Detektor der Retry-Politik, den
   * schon ein session-Event setzt): NUR echte Arbeit — Text, Denken,
   * Tool-Calls — rechtfertigt den „weiter"-Hinweis. Sonst verspräche die
   * Terminal-Zeile einen Zwischenstand, den es nicht gibt.
   */
  private sawWork = false;

  // Gebündeltes Streaming: Deltas landen sofort im Speicher (assistantRow/
  // thinkingRow/lastRow tragen immer den vollen Text), in die DB und an die
  // Abonnenten gehen sie höchstens einmal pro Zeitfenster. Ohne Bündelung
  // schrieb und sendete JEDES Delta die ganze Zeile neu — quadratisch in der
  // Antwortlänge, auf dem Event-Loop, den sich Proxy und Gateways teilen.
  private readonly pendingDeltas = new Map<string, ChatMessageRow>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Schreibvorgänge strikt hintereinander: der Timer feuert neben der
   * Event-Schleife, die Stände einer Zeile dürfen sich nie überholen.
   */
  private flushChain: Promise<void> = Promise.resolve();

  /**
   * Genau EIN laufendes next() teilen — sonst geht bei einem Timeout das gerade
   * schwebende Event verloren (der spätere Fehlertext läge im verworfenen next()).
   * Gesetzt, sobald der Runner gestartet ist.
   */
  private iterator: AsyncIterator<AgentEvent> | null = null;
  private pendingNext: Promise<IteratorResult<AgentEvent>> | null = null;

  constructor(
    private readonly deps: TurnAttemptDeps,
    private readonly slot: TurnAbortSlot,
    private readonly projectId: string,
    private readonly turn: AttemptTurn,
    private readonly isLastAttempt: boolean,
    private readonly allowResume: boolean,
  ) {}

  async run(): Promise<TurnAttemptResult> {
    const { store } = this.deps;
    const projectRow = await store.projectRow(this.projectId);

    // Modell PRO PROJEKT (Dropdown im Chat); langsame lokale Modelle bekommen
    // großzügigere Timeouts, sonst bricht der Watchdog mitten im „Denken" ab.
    // Steht das gespeicherte Modell nicht (mehr) im Katalog, läuft der Turn mit
    // dem Default — die Liste der Anthropic-Modelle ist Konfiguration.
    this.model = effectiveAgentModel(projectRow?.agentModel);
    const timeouts = agentTimeoutsFor(this.model, this.deps.fastTimeouts, this.deps.slowTimeouts);
    // Nur fortsetzen, wenn die Session mit dem AKTUELLEN Projekt-Modell erstellt
    // wurde. Sonst (anderes/kein Modell) frisch starten — ein Session-Resume
    // über einen Modellwechsel hinweg bringt den Agenten zum Hängen („Agent
    // arbeitet" ewig).
    const canResume =
      this.allowResume &&
      projectRow?.claudeSessionId != null &&
      projectRow.claudeSessionModel === this.model;
    // Kaltstart: erster Turn dieser (frischen) VM — mehr Zeit bis zum ersten Event.
    const firstEventBudget = canResume ? timeouts.firstEventMs : timeouts.coldStartMs;
    // Kontext-Recovery: OHNE Resume sähe der Agent nur den neuen Prompt (z. B.
    // nur „weiter"). Gibt es schon einen Chat-Verlauf (nach Interrupt-Reset
    // oder heilendem Retry), betten wir ihn in den Prompt ein — sonst startet
    // der Agent gedächtnislos. Mit Resume trägt die Session den Kontext.
    const prompt = canResume
      ? this.turn.prompt
      : await store.withHistoryContext(this.projectId, this.turn.turnId, this.turn.prompt);
    const rawHandle = this.deps.runner.startTurn({
      projectId: this.projectId,
      prompt,
      workspaceDir: this.turn.workspaceDir,
      resumeSessionId: canResume ? projectRow.claudeSessionId : null,
      model: this.model,
    });
    // Ein vom NUTZER ausgelöster Abbruch (Stop-Button, Steering) ist kein
    // Flake und darf deshalb keinen zweiten Durchlauf auslösen. Von aussen
    // ist nur dieses umhüllte Handle erreichbar (slot.currentHandle), der
    // Watchdog unten greift bewusst auf rawHandle zu — so bleiben die beiden
    // Abbruchgründe unterscheidbar.
    const handle: TurnHandle = {
      events: rawHandle.events,
      /**
       * Abbruch DURCH DEN NUTZER (Stop-Button, Steering) — beendet den Turn
       * endgültig, `runTurn` wiederholt ihn nicht.
       *
       * Das ist die einzige Stelle, an der `userAborted` gesetzt wird, und
       * dieses umhüllte Handle ist das einzige, das nach aussen gelangt
       * (`slot.currentHandle`). Der Watchdog weiter unten ruft bewusst
       * `rawHandle.abort()` — ein stiller Hänger ist genau der Fall, für den
       * der Retry existiert.
       */
      abort: () => {
        this.userAborted = true;
        rawHandle.abort();
      },
    };
    // Ab hier ist der Turn von aussen abbrechbar — und zwar nur über das
    // umhüllte Handle.
    this.slot.currentHandle = handle;
    // Ein Stop/Interrupt, der im Startfenster DIESES Turns ankam (aktiv, aber
    // Handle stand noch nicht), ist an genau diese turnId gepinnt — jetzt, wo
    // das Handle steht, wird er eingelöst. Bewusst über das UMHÜLLTE Handle:
    // das setzt `userAborted`, also kein Retry. Ein Pin auf eine fremde
    // turnId kann hier nicht auftauchen — die Pump räumt ihn spätestens am
    // Ende seines Turns.
    if (this.slot.abortActiveTurnId === this.turn.turnId) {
      this.slot.abortActiveTurnId = null;
      handle.abort();
    }

    const iterator = handle.events[Symbol.asyncIterator]();
    this.iterator = iterator;
    this.pendingNext = iterator.next();

    try {
      for (;;) {
        // Vor dem ersten Event gilt der kurze Start-Timeout (ein kaputter
        // Agent-Start wird in Sekunden erkannt), danach der großzügige
        // Idle-Timeout.
        const step = await this.race(this.sawAnyEvent ? timeouts.idleMs : firstEventBudget);
        if (step === 'timeout') {
          // Stiller Hänger: abbrechen. Beim letzten Versuch als Fehler SICHTBAR
          // machen (statt ewig „Agent arbeitet"); sonst folgt gleich der Retry.
          // Bewusst rawHandle: DAS hier ist der Watchdog, kein Nutzerabbruch —
          // ein Hänger ist genau der Fall, für den der Retry gedacht ist.
          rawHandle.abort();
          const detail = await this.drainForErrorDetail();
          if (this.userAborted) {
            // Nutzer-Stop, aber der Runner hat sein turn-aborted nie geliefert
            // (z. B. Daemon nie verbunden, M1): Terminal-Zeile trotzdem
            // schreiben — sonst bliebe die letzte Zeile die User-Nachricht
            // (resumeUnansweredTurn führte den gerade gestoppten Prompt beim
            // nächsten Öffnen erneut aus) und mangels lastRow würde
            // turnActive:false nie publiziert („Agent arbeitet" für immer).
            // Gleiches Vokabular wie der turn-aborted-Pfad, EIN Stop-Bild im UI.
            await this.insert('system', abortedText(this.sawWork));
          } else if (this.sawMeaningful || this.isLastAttempt) {
            const usedMs = this.sawAnyEvent ? timeouts.idleMs : firstEventBudget;
            const secs = Math.round(usedMs / 1000);
            await this.insert(
              'error',
              `Der Agent hat ${secs}s lang nicht reagiert und wurde abgebrochen.` +
                (detail
                  ? `\n\n${detail}`
                  : ' Kein weiterer Fehlertext verfügbar — mögliche Ursache: die Claude-API ' +
                    'antwortet nicht (Netz-/Rate-Limit-Problem).') +
                (this.sawWork ? `\n\n${CONTINUE_HINT}` : ''),
            );
          }
          break;
        }
        this.pendingNext = iterator.next();
        if (step.done) break;
        await this.handleEvent(step.value);
      }
    } catch (error) {
      // Runner-Fehler nie verschlucken — als error-Zeile in die Historie.
      // Der Insert selbst darf aber NICHT werfen (F18): wurde das Projekt
      // während des Turns gelöscht, scheitert er am Fremdschlüssel, und die
      // Exception entkäme über die floating pump() als Unhandled Rejection.
      try {
        await this.insert('error', error instanceof Error ? error.message : String(error));
      } catch (insertError) {
        console.error(
          `Fehlermeldung für ${this.projectId} konnte nicht gespeichert werden (Projekt gelöscht?):`,
          insertError,
        );
      }
    } finally {
      this.slot.currentHandle = null;
      // Rest schreiben, BEVOR das Turn-Ende signalisiert wird — sonst stünde in
      // der DB ein älterer Stand als im letzten Event. Darf nicht werfen (F18,
      // wie der Fehler-Insert oben: Projekt während des Turns gelöscht).
      try {
        await this.flushDeltas();
      } catch (flushError) {
        console.error(
          `Streaming-Stand für ${this.projectId} konnte nicht gespeichert werden (Projekt gelöscht?):`,
          flushError,
        );
      }
    }

    return {
      completed: this.completed,
      sawMeaningful: this.sawMeaningful,
      lastRow: this.lastRow,
      userAborted: this.userAborted,
    };
  }

  private flushDeltas(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const run = this.flushChain.then(async () => {
      const rows = [...this.pendingDeltas.values()];
      this.pendingDeltas.clear();
      for (const row of rows) {
        await this.deps.store.updateContent(row.id, row.content);
        this.deps.publish(this.projectId, row, true);
      }
    });
    // Ein gescheiterter Lauf (Projekt gelöscht) darf die Kette nicht vergiften;
    // der Fehler selbst erreicht den Aufrufer über `run`.
    this.flushChain = run.catch(() => {});
    return run;
  }

  /**
   * Jede NEUE Zeile schließt vorher die laufenden ab — Reihenfolge und Inhalt
   * stimmen so auch dann, wenn das Zeitfenster noch nicht abgelaufen ist.
   */
  private async insert(role: ChatMessageRow['role'], content: string): Promise<ChatMessageRow> {
    await this.flushDeltas();
    this.lastRow = await this.deps.insertMessage(this.projectId, this.turn.turnId, role, content);
    return this.lastRow;
  }

  /** Streamt ein Delta in die laufende Zeile der jeweiligen Rolle (assistant/thinking). */
  private async appendDelta(
    current: ChatMessageRow | null,
    role: ChatMessageRow['role'],
    text: string,
  ): Promise<ChatMessageRow> {
    if (current === null) {
      return this.insert(role, text);
    }
    // Deckel gegen unbegrenztes Wachstum (F16): ein kompromittierter Daemon
    // könnte sonst Speicher, Platte und alle SSE-Abonnenten sättigen. Die
    // Zeile wird abgeschlossen und eine neue begonnen — der Stream bricht
    // nicht ab, der Inhalt bleibt vollständig.
    if (current.content.length + text.length > MAX_MESSAGE_CHARS) {
      return this.insert(role, text);
    }
    const updated: ChatMessageRow = { ...current, content: current.content + text };
    this.lastRow = updated;
    this.pendingDeltas.set(updated.id, updated);
    if (this.deps.deltaFlushMs <= 0) {
      await this.flushDeltas();
    } else {
      // Ein Timer pro Fenster — er schreibt auch dann, wenn kein weiteres
      // Event mehr kommt (der Agent denkt nach), der Text bleibt nie hängen.
      this.flushTimer ??= setTimeout(() => {
        this.flushTimer = undefined;
        this.flushDeltas().catch((error: unknown) => {
          console.error(
            `Streaming-Stand für ${this.projectId} konnte nicht gespeichert werden:`,
            error,
          );
        });
      }, this.deps.deltaFlushMs);
    }
    return updated;
  }

  /** Wartet auf das schwebende next() — höchstens `timeoutMs`. */
  private async race(timeoutMs: number): Promise<IteratorResult<AgentEvent> | 'timeout'> {
    if (this.pendingNext === null) {
      throw new Error('TurnAttempt.race vor dem Start des Runners aufgerufen');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    try {
      return await Promise.race([this.pendingNext, timeoutP]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Nach dem Abbruch: kurz weiterlesen und einen etwaigen Fehlertext einsammeln. */
  private async drainForErrorDetail(): Promise<string> {
    const deadline = Date.now() + this.deps.abortGraceMs;
    const parts: string[] = [];
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const step = await this.race(remaining);
      if (step === 'timeout') break;
      this.pendingNext = this.iterator?.next() ?? null;
      if (step.done) break;
      if (step.value.type === 'error') parts.push(step.value.message);
    }
    return parts.join('\n');
  }

  private async handleEvent(event: AgentEvent): Promise<void> {
    this.deps.onAgentActivity(this.projectId);
    this.sawAnyEvent = true;
    if (event.type !== 'error' && event.type !== 'turn-aborted') {
      this.sawMeaningful = true;
    }
    switch (event.type) {
      case 'text-delta':
        this.sawWork = true;
        this.assistantRow = await this.appendDelta(this.assistantRow, 'assistant', event.text);
        break;
      case 'thinking-delta':
        this.sawWork = true;
        // Denken live in eine eigene Zeile streamen (falls die API es liefert).
        this.thinkingRow = await this.appendDelta(this.thinkingRow, 'thinking', event.text);
        break;
      case 'tool-use':
        this.sawWork = true;
        // Neuer Tool-Call beginnt: die laufende Text-/Denk-Bubble ist zu Ende.
        this.assistantRow = null;
        this.thinkingRow = null;
        await this.insert('tool', event.detail ? `${event.name}: ${event.detail}` : event.name);
        break;
      case 'block-stop':
        // Blockgrenze: die nächste Text-/Denk-Sequenz startet eine neue Bubble.
        await this.flushDeltas();
        this.assistantRow = null;
        this.thinkingRow = null;
        break;
      case 'session':
        // Session-ID früh sichern — überlebt auch einen abgebrochenen Turn (R9).
        await this.deps.store.saveSession(this.projectId, event.sessionId, this.model);
        break;
      case 'api-retry':
        // Sichtbar machen (R6) — aber nur einmal pro Turn, kein Retry-Spam.
        if (event.attempt === 1) {
          await this.insert(
            'system',
            `Claude-API-Störung: ${event.message} — automatische Wiederholung läuft (max. ${event.maxRetries} Versuche)`,
          );
        }
        break;
      case 'error':
        await this.insert('error', event.message);
        break;
      case 'turn-aborted':
        // Stiller Flake-Abbruch (nichts Sinnvolles passiert, Retry folgt):
        // keine verwirrende „Turn abgebrochen"-Zeile posten. Beim
        // Nutzerabbruch folgt kein Retry, also ist dieser Versuch der letzte
        // — die Rückmeldung MUSS dann sichtbar sein.
        if (this.userAborted || this.sawMeaningful || this.isLastAttempt) {
          await this.insert('system', abortedText(this.sawWork));
        }
        break;
      case 'turn-completed':
        this.completed = true;
        if (event.sessionId !== null) {
          await this.deps.store.saveSession(this.projectId, event.sessionId, this.model);
        }
        break;
    }
  }
}
