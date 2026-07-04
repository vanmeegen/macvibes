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
    let completed = false;

    try {
      for await (const event of handle.events) {
        this.hooks.onAgentActivity?.(projectId);
        switch (event.type) {
          case 'text-delta': {
            if (assistantRow === null) {
              assistantRow = await this.insertMessage(
                projectId,
                turn.turnId,
                'assistant',
                event.text,
              );
            } else {
              const previous: ChatMessageRow = assistantRow;
              assistantRow = { ...previous, content: previous.content + event.text };
              await this.db
                .update(chatMessages)
                .set({ content: assistantRow.content })
                .where(eq(chatMessages.id, assistantRow.id));
              this.publish(projectId, assistantRow, true);
            }
            break;
          }
          case 'tool-use':
            await this.insertMessage(
              projectId,
              turn.turnId,
              'tool',
              `${event.name}: ${event.detail}`,
            );
            break;
          case 'session':
            // Session-ID früh sichern — überlebt auch einen abgebrochenen Turn (R9).
            await this.db
              .update(projects)
              .set({ claudeSessionId: event.sessionId })
              .where(eq(projects.id, projectId));
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
