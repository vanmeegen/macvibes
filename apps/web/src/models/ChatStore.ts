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
  mutation SendMessage($projectId: ID!, $text: String!) {
    sendMessage(projectId: $projectId, text: $text)
  }
`;

const STOP_TURN_MUTATION = /* GraphQL */ `
  mutation StopTurn($projectId: ID!) {
    stopTurn(projectId: $projectId)
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
export class ChatStore {
  messages: ChatMessage[] = [];
  turnActive = false;
  error: string | null = null;
  draft = '';
  projectId: string | null = null;
  /** SSE-Verbindung — bewusst nicht observable. */
  eventSource: EventSource | null = null;

  constructor() {
    makeAutoObservable(this, { eventSource: false }, { autoBind: true });
  }

  setDraft(value: string): void {
    this.draft = value;
  }

  /** Upsert per Message-ID — Streaming-Deltas ersetzen die bestehende Zeile. */
  applyEvent(payload: ChatEventPayload): void {
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
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
    this.projectId = null;
  }

  async send(): Promise<void> {
    const projectId = this.projectId;
    const text = this.draft.trim();
    if (projectId === null || text.length === 0) return;

    this.draft = '';
    this.error = null;
    try {
      await gqlRequest<{ sendMessage: boolean }>(SEND_MESSAGE_MUTATION, { projectId, text });
    } catch (err) {
      console.error('ChatStore.send fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
        // Entwurf wiederherstellen, damit nichts verloren geht (R6).
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
