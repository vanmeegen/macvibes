import { asc, eq, sql } from 'drizzle-orm';
import { AGENT_MODEL } from '../agent/agentModel';
import type { AgentEvent } from '../agent/events';
import type { AgentRunner, TurnHandle } from '../agent/runner';
import type { Db } from '../db/client';
import { chatMessages, projects, type ChatMessageRow } from '../db/schema';

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
  resumeSessionId: string | null;
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
  currentHandle: TurnHandle | null;
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
  /** Nachlauf nach dem Abbruch, um einen späten Fehlertext (stderr) einzusammeln. */
  agentAbortGraceMs?: number | undefined;
}

export class ChatService {
  private readonly states = new Map<string, ProjectChatState>();
  private readonly idleTimeoutMs: number;
  private readonly firstEventTimeoutMs: number;
  private readonly abortGraceMs: number;

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
    this.abortGraceMs = options.agentAbortGraceMs ?? 5_000;
  }

  private state(projectId: string): ProjectChatState {
    let state = this.states.get(projectId);
    if (!state) {
      state = { queue: [], pumpRunning: false, currentHandle: null, subscribers: new Set() };
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
    const state = this.states.get(projectId);
    if (!state) return false;
    return state.pumpRunning || state.queue.length > 0 || state.currentHandle !== null;
  }

  /** Persistiert die Nutzer-Nachricht sofort und reiht den Turn ein (Queue, R6). */
  async sendMessage(input: SendMessageInput): Promise<void> {
    const state = this.state(input.projectId);
    const turnId = crypto.randomUUID();
    state.queue.push({ turnId, prompt: input.text, workspaceDir: input.workspaceDir });
    await this.insertMessage(input.projectId, turnId, 'user', input.text);
    // Mid-Turn-Steering (Phase C): laufenden Turn abbrechen, damit die Pump
    // sofort zur neuen Nachricht springt. Die Queue bleibt erhalten.
    if (input.interrupt === true) {
      state.currentHandle?.abort();
    }
    void this.pump(input.projectId);
  }

  /** Systemseitige Nachricht in Historie + Stream (z. B. Auto-Commit-Fehler, R8). */
  async postMessage(
    projectId: string,
    role: ChatMessageRow['role'],
    content: string,
  ): Promise<void> {
    await this.insertMessage(projectId, crypto.randomUUID(), role, content);
  }

  /** Bricht den laufenden Turn ab und leert die Warteschlange (Stop-Button, R6). */
  stopTurn(projectId: string): void {
    const state = this.state(projectId);
    state.queue.length = 0;
    state.currentHandle?.abort();
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
    for (const subscriber of this.state(projectId).subscribers) {
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
    const inserted = await this.db
      .insert(chatMessages)
      .values({ id: crypto.randomUUID(), projectId, turnId, role, content })
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
        await this.runTurn(projectId, turn);
        turn = state.queue.shift();
      }
    } finally {
      state.pumpRunning = false;
    }
  }

  private async runTurn(projectId: string, turn: QueuedTurn): Promise<void> {
    const state = this.state(projectId);
    // msb exec ist gelegentlich flaky: die Exec-Session stirbt oder liefert nie
    // Output. Liefert ein Versuch KEIN einziges sinnvolles Event, wird er genau
    // einmal wiederholt (transparent per Systemzeile) — erst dann Fehler.
    const maxAttempts = 2;
    let lastRow: ChatMessageRow | null = null;
    let completed = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.runAttempt(projectId, turn, attempt === maxAttempts);
      if (result.lastRow !== null) lastRow = result.lastRow;
      completed = result.completed;
      if (result.completed || result.sawMeaningful) break;
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

  private async runAttempt(
    projectId: string,
    turn: QueuedTurn,
    isLastAttempt: boolean,
  ): Promise<{ completed: boolean; sawMeaningful: boolean; lastRow: ChatMessageRow | null }> {
    const state = this.state(projectId);
    const projectRow = (
      await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
    )[0];

    // Nur fortsetzen, wenn die Session mit dem AKTUELLEN Modell erstellt wurde.
    // Sonst (anderes/kein Modell) frisch starten — ein --resume über einen
    // Modellwechsel hinweg bringt Claude Code zum Hängen ("Agent arbeitet" ewig).
    const canResume =
      projectRow?.claudeSessionId != null && projectRow.claudeSessionModel === AGENT_MODEL;
    const handle = this.runner.startTurn({
      projectId,
      prompt: turn.prompt,
      workspaceDir: turn.workspaceDir,
      resumeSessionId: canResume ? projectRow.claudeSessionId : null,
    });
    state.currentHandle = handle;

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
            .set({ claudeSessionId: event.sessionId, claudeSessionModel: AGENT_MODEL })
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
          // keine verwirrende „Turn abgebrochen"-Zeile posten.
          if (sawMeaningful || isLastAttempt) {
            await insert('system', 'Turn abgebrochen');
          }
          break;
        case 'turn-completed':
          completed = true;
          if (event.sessionId !== null) {
            await this.db
              .update(projects)
              .set({ claudeSessionId: event.sessionId, claudeSessionModel: AGENT_MODEL })
              .where(eq(projects.id, projectId));
          }
          break;
      }
    };

    try {
      for (;;) {
        // Vor dem ersten Event gilt der kurze Start-Timeout (kaputter msb-exec
        // wird in Sekunden erkannt), danach der großzügige Idle-Timeout.
        const step = await race(sawAnyEvent ? this.idleTimeoutMs : this.firstEventTimeoutMs);
        if (step === 'timeout') {
          // Stiller Hänger: abbrechen. Beim letzten Versuch als Fehler SICHTBAR
          // machen (statt ewig „Agent arbeitet"); sonst folgt gleich der Retry.
          handle.abort();
          const detail = await drainForErrorDetail();
          if (sawMeaningful || isLastAttempt) {
            const usedMs = sawAnyEvent ? this.idleTimeoutMs : this.firstEventTimeoutMs;
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
      await insert('error', error instanceof Error ? error.message : String(error));
    } finally {
      state.currentHandle = null;
    }

    return { completed, sawMeaningful, lastRow };
  }
}
