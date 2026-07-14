import type { GatewayListener } from './agentGateway';
import type { HostToDaemonMessage } from './daemon/protocol';
import type { AgentEvent } from './events';
import type { AgentRunner, TurnHandle, TurnOptions } from './runner';

/** Der Ausschnitt des AgentGateway, den der Runner braucht (Test-Naht). */
export interface GatewayApi {
  waitForConnection(sandbox: string, timeoutMs: number): Promise<void>;
  send(sandbox: string, message: HostToDaemonMessage): boolean;
  subscribe(sandbox: string, listener: GatewayListener): () => void;
  /** Verwirft eine (mutmaßlich halbtote) Verbindung — Reconnect heilt. */
  invalidate(sandbox: string): void;
}

export interface DaemonAgentRunnerConfig {
  gateway: GatewayApi;
  /** Sandbox-Name zu einem Projekt (muss mit dem Provider übereinstimmen). */
  sandboxNameFor: (projectId: string) => string;
  /** Wartezeit, bis der Daemon der (ggf. frisch bootenden) VM verbunden ist. */
  connectTimeoutMs?: number;
  /**
   * Frist für die turn-started-Quittung des Daemons. Bleibt sie aus, war die
   * Verbindung halbtot (msb-NAT verschluckt FIN/RST) — Turn schnell abbrechen
   * statt ewig warten; der Retry des chatService trifft die frische Verbindung.
   * MUSS unter dem firstEventTimeout des chatService (8s) liegen, sonst bricht
   * dessen Watchdog zuerst ab und der Retry träfe wieder die tote Verbindung.
   */
  ackTimeoutMs?: number;
}

/**
 * AgentRunner über den persistenten Agent-Daemon in der VM (Spike A+C):
 * startTurn schickt ein Kommando über die stehende WS-Verbindung des
 * Gateways und liefert die AgentEvents des Daemons als AsyncIterable.
 * abort() ist ein sauberer `interrupt` — kein Prozess-Kill, keine
 * korrupte Session.
 */
export class DaemonAgentRunner implements AgentRunner {
  constructor(private readonly config: DaemonAgentRunnerConfig) {}

  startTurn(options: TurnOptions): TurnHandle {
    const { gateway } = this.config;
    // Modell pro Turn (Modellwahl pro Chat/Projekt) — der Daemon startet die
    // SDK-Query bei Modellwechsel ohnehin frisch (daemonSession).
    const model = options.model;
    const sandbox = this.config.sandboxNameFor(options.projectId);
    const connectTimeoutMs = this.config.connectTimeoutMs ?? 60_000;
    const ackTimeoutMs = this.config.ackTimeoutMs ?? 5_000;
    const turnId = crypto.randomUUID();

    // Eingehende Events puffern, bis der Generator sie abholt.
    const queue: AgentEvent[] = [];
    let waiter: (() => void) | null = null;
    let finished = false;
    let aborted = false;
    let acked = false;

    const pushAll = (events: AgentEvent[]): void => {
      if (finished) return;
      queue.push(...events);
      if (events.some((e) => e.type === 'turn-completed' || e.type === 'turn-aborted')) {
        finished = true;
      }
      waiter?.();
    };

    const unsubscribe = gateway.subscribe(sandbox, (notification) => {
      if (notification.kind === 'disconnected') {
        // Daemon weg (Crash/Neustart durch den Supervisor) — Turn ist verloren,
        // die Claude-Session selbst überlebt in der VM.
        pushAll([
          { type: 'error', message: 'Verbindung zum Agent-Daemon verloren' },
          { type: 'turn-aborted' },
        ]);
        return;
      }
      const { message } = notification;
      if (message.kind === 'turn-started' && message.turnId === turnId) {
        acked = true;
        return;
      }
      if (message.kind !== 'event' || message.turnId !== turnId) return;
      acked = true;
      pushAll([message.event]);
    });

    const events = (async function* (): AsyncGenerator<AgentEvent> {
      try {
        try {
          await gateway.waitForConnection(sandbox, connectTimeoutMs);
        } catch (error) {
          yield {
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
          yield { type: 'turn-aborted' };
          return;
        }
        if (aborted) {
          yield { type: 'turn-aborted' };
          return;
        }

        const sent = gateway.send(sandbox, {
          kind: 'start-turn',
          turnId,
          prompt: options.prompt,
          resumeSessionId: options.resumeSessionId,
          model,
        });
        if (!sent) {
          yield {
            type: 'error',
            message: 'Agent-Daemon nicht erreichbar (Verbindung beim Senden weg)',
          };
          yield { type: 'turn-aborted' };
          return;
        }

        // Quittungs-Wächter: bestätigt der Daemon den Turn nicht, ging das
        // Kommando an eine halbtote Verbindung — schnell scheitern (der
        // chatService-Retry trifft dann die frische Verbindung) und die
        // veraltete Verbindung verwerfen, damit waitForConnection echt wartet.
        const ackTimer = setTimeout(() => {
          if (acked || finished) return;
          gateway.invalidate(sandbox);
          pushAll([
            {
              type: 'error',
              message: 'Agent-Daemon hat den Turn nicht bestätigt (Verbindung veraltet?)',
            },
            { type: 'turn-aborted' },
          ]);
        }, ackTimeoutMs);
        try {
          for (;;) {
            while (queue.length > 0) {
              const event = queue.shift() as AgentEvent;
              yield event;
              if (event.type === 'turn-completed' || event.type === 'turn-aborted') {
                return;
              }
            }
            await new Promise<void>((resolve) => {
              waiter = resolve;
            });
            waiter = null;
          }
        } finally {
          clearTimeout(ackTimer);
        }
      } finally {
        finished = true;
        unsubscribe();
      }
    })();

    return {
      events,
      abort: () => {
        if (finished || aborted) return;
        aborted = true;
        // Sauberer Abbruch statt Kill: der Daemon ruft SDK-interrupt(), die
        // Claude-Session bleibt intakt. Lokal beenden wir den Stream sofort.
        gateway.send(sandbox, { kind: 'interrupt', turnId });
        pushAll([{ type: 'turn-aborted' }]);
      },
    };
  }
}
