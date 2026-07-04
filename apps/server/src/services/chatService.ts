import { asc, eq, sql } from 'drizzle-orm';
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

export class ChatService {
  private readonly states = new Map<string, ProjectChatState>();

  constructor(
    private readonly db: Db,
    private readonly runner: AgentRunner,
    private readonly hooks: ChatHooks = {},
  ) {}

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
    const projectRow = (
      await this.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
    )[0];

    const handle = this.runner.startTurn({
      projectId,
      prompt: turn.prompt,
      workspaceDir: turn.workspaceDir,
      resumeSessionId: projectRow?.claudeSessionId ?? null,
    });
    state.currentHandle = handle;

    let assistantRow: ChatMessageRow | null = null;
    let thinkingRow: ChatMessageRow | null = null;
    let completed = false;

    // Streamt ein Delta in die laufende Zeile der jeweiligen Rolle (assistant/thinking).
    const appendDelta = async (
      current: ChatMessageRow | null,
      role: ChatMessageRow['role'],
      text: string,
    ): Promise<ChatMessageRow> => {
      if (current === null) {
        return this.insertMessage(projectId, turn.turnId, role, text);
      }
      const updated: ChatMessageRow = { ...current, content: current.content + text };
      await this.db
        .update(chatMessages)
        .set({ content: updated.content })
        .where(eq(chatMessages.id, updated.id));
      this.publish(projectId, updated, true);
      return updated;
    };

    try {
      for await (const event of handle.events) {
        this.hooks.onAgentActivity?.(projectId);
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
            await this.insertMessage(
              projectId,
              turn.turnId,
              'tool',
              event.detail ? `${event.name}: ${event.detail}` : event.name,
            );
            break;
          case 'block-stop':
            // Blockgrenze: die nächste Text-/Denk-Sequenz startet eine neue Bubble.
            assistantRow = null;
            thinkingRow = null;
            break;
          case 'session':
            // Session-ID früh sichern — überlebt auch einen abgebrochenen Turn (R9).
            await this.db
              .update(projects)
              .set({ claudeSessionId: event.sessionId })
              .where(eq(projects.id, projectId));
            break;
          case 'api-retry':
            // Sichtbar machen (R6) — aber nur einmal pro Turn, kein Retry-Spam.
            if (event.attempt === 1) {
              await this.insertMessage(
                projectId,
                turn.turnId,
                'system',
                `Claude-API-Störung: ${event.message} — automatische Wiederholung läuft (max. ${event.maxRetries} Versuche)`,
              );
            }
            break;
          case 'error':
            await this.insertMessage(projectId, turn.turnId, 'error', event.message);
            break;
          case 'turn-aborted':
            await this.insertMessage(
              projectId,
              turn.turnId,
              'system',
              'Turn abgebrochen',
              state.queue.length > 0,
            );
            break;
          case 'turn-completed': {
            completed = true;
            if (event.sessionId !== null) {
              await this.db
                .update(projects)
                .set({ claudeSessionId: event.sessionId })
                .where(eq(projects.id, projectId));
            }
            if (assistantRow !== null) {
              // Abschluss signalisieren: letzte Assistant-Zeile mit turnActive=false.
              this.publish(projectId, assistantRow, state.queue.length > 0);
            }
            break;
          }
        }
      }
    } catch (error) {
      // Runner-Fehler nie verschlucken — als error-Zeile in die Historie.
      await this.insertMessage(
        projectId,
        turn.turnId,
        'error',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      state.currentHandle = null;
    }

    if (completed) {
      await this.hooks.onTurnEnd?.(projectId, turn.prompt);
    }
  }
}
