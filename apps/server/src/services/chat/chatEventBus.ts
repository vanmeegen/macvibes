import type { ChatMessageRow } from '../../db/schema';

export interface ChatEventPayload {
  message: ChatMessageRow;
  /** Läuft für dieses Projekt gerade (oder gleich, Queue) ein Agent-Turn? */
  turnActive: boolean;
}

type Subscriber = (payload: ChatEventPayload) => void;

/**
 * Verteilt Chat-Events eines Projekts an seine Live-Abonnenten (SSE-Streams).
 * Reines In-Memory-Pub/Sub — kennt weder Queue noch Datenbank.
 */
export class ChatEventBus {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  /** Live-Stream aller Chat-Events eines Projekts. */
  subscribe(projectId: string): AsyncIterableIterator<ChatEventPayload> {
    let subscribers = this.subscribers.get(projectId);
    if (!subscribers) {
      subscribers = new Set();
      this.subscribers.set(projectId, subscribers);
    }
    // Das Set festhalten: `return()` meldet sich an GENAU diesem Set ab, auch
    // wenn das Projekt inzwischen per forget() vergessen wurde.
    const ownSubscribers = subscribers;
    const buffer: ChatEventPayload[] = [];
    let notify: (() => void) | null = null;
    let closed = false;

    const push = (payload: ChatEventPayload): void => {
      // Neuester Stand gewinnt: liegt der letzte noch ungelesene Eintrag zur
      // SELBEN Zeile vor (Streaming), wird er ersetzt statt ein weiterer
      // Voll-Schnappschuss angehängt. Ein langsamer Abonnent hält so pro Zeile
      // einen Stand statt einer wachsenden Reihe; Clients upserten per ID.
      const last = buffer[buffer.length - 1];
      if (last !== undefined && last.message.id === payload.message.id) {
        buffer[buffer.length - 1] = payload;
      } else {
        buffer.push(payload);
      }
      notify?.();
    };
    ownSubscribers.add(push);

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
        ownSubscribers.delete(push);
        notify?.();
        return { value: undefined, done: true };
      },
    };
    return iterator;
  }

  publish(projectId: string, message: ChatMessageRow, turnActive: boolean): void {
    // Bewusst nur lesen, nie anlegen: ein noch auslaufender Turn eines
    // GELÖSCHTEN Projekts (forget() hat den Eintrag entfernt) darf hier keinen
    // frischen, leeren Eintrag erzeugen — sonst kehrt das Leck zurück. Ohne
    // Eintrag gibt es keine Abonnenten, an die zu senden wäre.
    const subscribers = this.subscribers.get(projectId);
    if (!subscribers) return;
    for (const subscriber of subscribers) {
      subscriber({ message, turnActive });
    }
  }

  /** Vergisst alle Abonnenten eines Projekts — für gelöschte Projekte. */
  forget(projectId: string): void {
    this.subscribers.get(projectId)?.clear();
    this.subscribers.delete(projectId);
  }
}
