import { makeAutoObservable, runInAction } from 'mobx';
import { gqlRequest } from '../api/graphqlClient';
import type { ChatMessage } from '../api/types';

export interface ChatEventPayload {
  message: ChatMessage;
  turnActive: boolean;
}

const CHAT_STATE_QUERY = /* GraphQL */ `
  query ChatState($projectId: ID!) {
    chatMessages(projectId: $projectId) {
      id
      projectId
      turnId
      role
      content
      createdAt
    }
    turnActive(projectId: $projectId)
  }
`;

const SEND_MESSAGE_MUTATION = /* GraphQL */ `
  mutation SendMessage($projectId: ID!, $text: String!, $interrupt: Boolean) {
    sendMessage(projectId: $projectId, text: $text, interrupt: $interrupt)
  }
`;

const STOP_TURN_MUTATION = /* GraphQL */ `
  mutation StopTurn($projectId: ID!) {
    stopTurn(projectId: $projectId)
  }
`;

const TURN_ACTIVE_QUERY = /* GraphQL */ `
  query TurnActive($projectId: ID!) {
    turnActive(projectId: $projectId)
  }
`;

const CHAT_EVENTS_SUBSCRIPTION = (projectId: string): string => /* GraphQL */ `
  subscription {
    chatEvents(projectId: ${JSON.stringify(projectId)}) {
      turnActive
      message {
        id
        projectId
        turnId
        role
        content
        createdAt
      }
    }
  }
`;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Presentation Model der Chat-Page: Verlauf, Streaming-Events (SSE via
 * GraphQL-Subscription), Eingabe-Entwurf, Turn-Status und Stop (R6).
 */
/** Präfix der optimistischen (noch nicht serverbestätigten) User-Bubbles. */
const OPTIMISTIC_PREFIX = 'optimistic-';

export class ChatStore {
  messages: ChatMessage[] = [];
  turnActive = false;
  /** Chat-Spalte ausgeblendet → Preview nimmt das ganze Fenster ein. */
  chatCollapsed = false;
  error: string | null = null;
  draft = '';
  projectId: string | null = null;
  /** Zähler für eindeutige optimistische IDs. */
  optimisticCounter = 0;
  /** SSE-Verbindung — bewusst nicht observable. */
  eventSource: EventSource | null = null;
  /** Reconcile-Timer gegen verpasste Turn-Ende-Events — nicht observable. */
  reconcileTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    makeAutoObservable(this, { eventSource: false, reconcileTimer: false }, { autoBind: true });
  }

  setDraft(value: string): void {
    this.draft = value;
  }

  toggleChatCollapsed(): void {
    this.chatCollapsed = !this.chatCollapsed;
  }

  /**
   * Sicherheitsnetz: fragt den Server nach dem echten Turn-Status. Reißt die
   * SSE-Verbindung ab und geht das finale turnActive=false verloren, würde die
   * UI sonst auf „Agent arbeitet" hängen bleiben.
   */
  async reconcileTurnActive(): Promise<void> {
    const projectId = this.projectId;
    if (projectId === null || !this.turnActive) return;
    try {
      const data = await gqlRequest<{ turnActive: boolean }>(TURN_ACTIVE_QUERY, { projectId });
      runInAction(() => {
        if (!data.turnActive) this.turnActive = false;
      });
    } catch (err) {
      console.error('ChatStore.reconcileTurnActive fehlgeschlagen', err);
    }
  }

  /** Upsert per Message-ID — Streaming-Deltas ersetzen die bestehende Zeile. */
  applyEvent(payload: ChatEventPayload): void {
    // Ist es die serverseitige Fassung unserer optimistischen User-Bubble,
    // die eigene Bubble durch das echte Event ersetzen (kein Duplikat).
    if (payload.message.role === 'user') {
      const optimistic = this.messages.findIndex(
        (m) => m.id.startsWith(OPTIMISTIC_PREFIX) && m.content === payload.message.content,
      );
      if (optimistic >= 0) {
        this.messages.splice(optimistic, 1);
      }
    }
    const index = this.messages.findIndex((m) => m.id === payload.message.id);
    if (index >= 0) {
      this.messages[index] = payload.message;
    } else {
      this.messages.push(payload.message);
    }
    this.turnActive = payload.turnActive;
  }

  /** Lädt die Historie und abonniert Live-Events (auch read-only, R10). */
  async connect(projectId: string): Promise<void> {
    this.disconnect();
    this.projectId = projectId;
    this.messages = [];
    this.error = null;
    // Projektwechsel: Chat immer sichtbar starten (kein „versteckter" Chat).
    this.chatCollapsed = false;

    try {
      const data = await gqlRequest<{ chatMessages: ChatMessage[]; turnActive: boolean }>(
        CHAT_STATE_QUERY,
        { projectId },
      );
      runInAction(() => {
        this.messages = data.chatMessages;
        this.turnActive = data.turnActive;
      });
    } catch (err) {
      console.error('ChatStore.connect fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
      return;
    }

    const url = `/graphql?query=${encodeURIComponent(CHAT_EVENTS_SUBSCRIPTION(projectId))}`;
    const eventSource = new EventSource(url);
    // GraphQL Yoga sendet benannte SSE-Events ("event: next"), nicht "message".
    eventSource.addEventListener('next', (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as { data?: { chatEvents?: ChatEventPayload } };
        const payload = parsed.data?.chatEvents;
        if (payload) {
          this.applyEvent(payload);
        }
      } catch (err) {
        console.error('Chat-Event konnte nicht verarbeitet werden', err);
      }
    });
    eventSource.onerror = (err) => {
      // EventSource verbindet sich automatisch neu — nur protokollieren.
      console.error('Chat-Subscription unterbrochen', err);
    };
    this.eventSource = eventSource;

    // Sicherheitsnetz: regelmäßig mit dem echten Server-Status abgleichen.
    this.reconcileTimer = setInterval(() => void this.reconcileTurnActive(), 5000);
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.projectId = null;
  }

  async send(): Promise<void> {
    const projectId = this.projectId;
    const text = this.draft.trim();
    if (projectId === null || text.length === 0) return;

    // Läuft schon ein Turn, unterbricht die neue Anweisung ihn (Mid-Turn-Steering).
    const interrupt = this.turnActive;
    this.draft = '';
    this.error = null;

    // Optimistisch: die eigene Bubble SOFORT anzeigen und den Turn als aktiv
    // markieren („Agent arbeitet…") — kein Warten auf den Server-Roundtrip.
    const optimisticId = `${OPTIMISTIC_PREFIX}${this.optimisticCounter++}`;
    this.messages.push({
      id: optimisticId,
      projectId,
      turnId: optimisticId,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    });
    this.turnActive = true;

    try {
      await gqlRequest<{ sendMessage: boolean }>(SEND_MESSAGE_MUTATION, {
        projectId,
        text,
        interrupt,
      });
    } catch (err) {
      console.error('ChatStore.send fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
        // Optimistische Bubble zurücknehmen und Entwurf wiederherstellen (R6).
        this.messages = this.messages.filter((m) => m.id !== optimisticId);
        if (!this.messages.some((m) => m.id.startsWith(OPTIMISTIC_PREFIX))) {
          this.turnActive = false;
        }
        this.draft = text;
      });
    }
  }

  async stop(): Promise<void> {
    const projectId = this.projectId;
    if (projectId === null) return;
    try {
      await gqlRequest<{ stopTurn: boolean }>(STOP_TURN_MUTATION, { projectId });
    } catch (err) {
      console.error('ChatStore.stop fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    }
  }
}
