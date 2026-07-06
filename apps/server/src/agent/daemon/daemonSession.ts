import { agentEventsFromMessage } from '../claudeStreamJson';
import type { AgentEvent } from '../events';
import type { DaemonToHostMessage } from './protocol';

/**
 * Nutzer-Nachricht im Streaming-Input-Format des Agent SDK. Nur die Felder,
 * die der Daemon tatsächlich befüllt.
 */
export interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
}

/** Das, was der Daemon von einer SDK-`query()` braucht (Test-Naht). */
export interface QueryHandle extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
}

export interface QueryParams {
  prompt: AsyncIterable<SdkUserMessage>;
  cwd: string;
  model: string;
  resumeSessionId: string | null;
}

/** Erzeugt eine langlebige SDK-Query (Produktion: `query()` aus dem Agent SDK). */
export type QueryFactory = (params: QueryParams) => QueryHandle;

export interface DaemonSessionConfig {
  createQuery: QueryFactory;
  /** Arbeitsverzeichnis des Agenten in der VM (gemounteter Workspace). */
  cwd: string;
  emit: (message: DaemonToHostMessage) => void;
}

export interface StartTurnParams {
  turnId: string;
  prompt: string;
  resumeSessionId: string | null;
  model: string;
}

interface PushIterable<T> {
  iterable: AsyncIterable<T>;
  push(value: T): void;
  end(): void;
}

function createPushIterable<T>(): PushIterable<T> {
  const queue: T[] = [];
  let waiter: (() => void) | null = null;
  let ended = false;
  return {
    push(value: T): void {
      queue.push(value);
      waiter?.();
    },
    end(): void {
      ended = true;
      waiter?.();
    },
    iterable: {
      async *[Symbol.asyncIterator](): AsyncIterator<T> {
        for (;;) {
          while (queue.length > 0) {
            yield queue.shift() as T;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
          waiter = null;
        }
      },
    },
  };
}

interface LiveQuery {
  handle: QueryHandle;
  model: string;
  input: PushIterable<SdkUserMessage>;
}

/**
 * Kern des Agent-Daemons: hält EINE langlebige SDK-Query (Streaming-Input)
 * über beliebig viele Turns, mappt SDK-Messages auf AgentEvents (getaggt mit
 * der turnId) und bricht Turns per `interrupt()` sauber ab — kein Kill, keine
 * korrupte Session (chatproblems.md #13).
 */
export class DaemonSession {
  private live: LiveQuery | null = null;
  private currentTurnId: string | null = null;
  private interrupted = false;

  constructor(private readonly config: DaemonSessionConfig) {}

  startTurn(params: StartTurnParams): void {
    if (this.currentTurnId !== null) {
      // Der Host serialisiert Turns pro Projekt — das hier ist reine Notwehr.
      this.emitEvent(params.turnId, {
        type: 'error',
        message: 'Agent-Daemon: Turn abgewiesen — es läuft bereits ein Turn.',
      });
      this.emitEvent(params.turnId, { type: 'turn-aborted' });
      return;
    }

    let resumeSessionId = params.resumeSessionId;
    if (this.live !== null && this.live.model !== params.model) {
      // Modellwechsel: Resume über Modellgrenzen hängt (agentModel.ts) —
      // Query beenden und frisch (ohne resume) starten.
      this.live.input.end();
      this.live = null;
      resumeSessionId = null;
    }

    if (this.live === null) {
      this.live = this.createLive(params.model, resumeSessionId);
    }

    this.currentTurnId = params.turnId;
    this.interrupted = false;
    this.live.input.push({
      type: 'user',
      message: { role: 'user', content: params.prompt },
      parent_tool_use_id: null,
    });
  }

  interrupt(turnId: string): void {
    if (this.currentTurnId !== turnId || this.live === null) return;
    this.interrupted = true;
    this.live.handle.interrupt().catch((error) => {
      // Der Host hat lokal bereits abgebrochen; hier nur Diagnose.
      console.error('Agent-Daemon: interrupt() fehlgeschlagen:', error);
    });
  }

  private createLive(model: string, resumeSessionId: string | null): LiveQuery {
    const input = createPushIterable<SdkUserMessage>();
    const handle = this.config.createQuery({
      prompt: input.iterable,
      cwd: this.config.cwd,
      model,
      resumeSessionId,
    });
    const live: LiveQuery = { handle, model, input };
    void this.consume(live);
    return live;
  }

  /** Liest die SDK-Query bis zu ihrem Ende — über alle Turns hinweg. */
  private async consume(live: LiveQuery): Promise<void> {
    try {
      for await (const message of live.handle) {
        if (this.live === live) {
          this.handleMessage(message);
        }
      }
      this.handleQueryEnd(live, null);
    } catch (error) {
      this.handleQueryEnd(live, error);
    }
  }

  private handleMessage(message: unknown): void {
    const turnId = this.currentTurnId;
    if (turnId === null) return; // Nachzügler ohne aktiven Turn — verwerfen.

    for (const event of agentEventsFromMessage(message)) {
      // Nach einem Interrupt ist der error-result des SDK erwartet — kein
      // echter Fehler, den der Nutzer sehen müsste.
      if (this.interrupted && event.type === 'error') continue;
      this.emitEvent(turnId, event);
      if (event.type === 'turn-completed' || event.type === 'turn-aborted') {
        this.currentTurnId = null;
        this.interrupted = false;
      }
    }
  }

  /** Query endete (still oder mit Fehler) — laufenden Turn sauber abbrechen. */
  private handleQueryEnd(live: LiveQuery, error: unknown): void {
    if (this.live !== live) return; // durch Modellwechsel ersetzt — irrelevant.
    this.live = null;

    const turnId = this.currentTurnId;
    if (turnId === null) return;
    this.currentTurnId = null;

    if (error !== null && !this.interrupted) {
      this.emitEvent(turnId, {
        type: 'error',
        message: `Agent-SDK-Stream abgebrochen: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    this.interrupted = false;
    this.emitEvent(turnId, { type: 'turn-aborted' });
  }

  private emitEvent(turnId: string, event: AgentEvent): void {
    this.config.emit({ kind: 'event', turnId, event });
  }
}
