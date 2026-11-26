import { parseHostToDaemon } from './protocol';
import type { DaemonToHostMessage, HostToDaemonMessage } from './protocol';

/** Der Ausschnitt von WebSocket, den die Verbindung braucht (Test-Naht). */
export interface GatewaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void,
  ): void;
}

type StartTurnMessage = Extract<HostToDaemonMessage, { kind: 'start-turn' }>;

export interface GatewayConnectionOptions {
  url: string;
  /** Die Turn-Steuerung, an die Host-Kommandos gehen (DaemonSession). */
  session: {
    startTurn(message: StartTurnMessage): void;
    interrupt(turnId: string): void;
    abandonTurn(): void;
  };
  /** shutdown-Kommando des Hosts: Prozess beenden, der In-VM-Supervisor startet neu. */
  onShutdown: () => void;
  /** Test-Nähte; Defaults sind WebSocket und die globalen Timer. */
  createSocket?: (url: string) => GatewaySocket;
  setTimeout?: (run: () => void, delayMs: number) => void;
  setInterval?: (run: () => void, everyMs: number) => () => void;
  log?: (message: string) => void;
  logError?: (message: string, detail?: unknown) => void;
}

/**
 * Heartbeat-Intervall: hält den NAT-Flow VM→Host warm. microsandbox lässt
 * idle TCP-Flows nach kurzer Zeit still sterben — ohne Ping verschwinden
 * Host-Kommandos nach ruhigen Phasen spurlos (Live-Befund 2026-07-06).
 */
const PING_INTERVAL_MS = 15_000;

/** WebSocket.OPEN — als Zahl, damit die Test-Naht keinen globalen WebSocket braucht. */
const SOCKET_OPEN = 1;

/**
 * So viele Pings dürfen unbeantwortet bleiben, bevor die Verbindung als tot
 * gilt. Zwei statt einem: ein einzelner Pong kann im Lastfall verspätet sein.
 */
const MAX_UNBEANTWORTETE_PINGS = 2;

/** Wartezeit vor dem n-ten Reconnect-Versuch: 0,5 s, verdoppelt bis 8 s. */
function reconnectDelayMs(attempt: number): number {
  return 500 * 2 ** Math.min(attempt, 4);
}

/**
 * Dauerhafte, ausgehende Verbindung des Daemons zum Host-Gateway: meldet sich
 * an, hält sie per Ping warm, verteilt Host-Kommandos an die Session und
 * verbindet nach einem Abriss mit Backoff neu. Die Session lebt über Abrisse
 * hinweg weiter — nur der laufende Turn wird freigegeben.
 */
export class GatewayConnection {
  private socket: GatewaySocket | null = null;
  private attempt = 0;
  private readonly createSocket: (url: string) => GatewaySocket;
  private readonly schedule: (run: () => void, delayMs: number) => void;
  private readonly every: (run: () => void, everyMs: number) => () => void;
  private readonly log: (message: string) => void;
  private readonly logError: (message: string, detail?: unknown) => void;

  constructor(private readonly options: GatewayConnectionOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as GatewaySocket);
    this.schedule = options.setTimeout ?? ((run, delayMs) => void setTimeout(run, delayMs));
    this.every =
      options.setInterval ??
      ((run, everyMs) => {
        const timer = setInterval(run, everyMs);
        return () => clearInterval(timer);
      });
    this.log = options.log ?? ((message) => console.log(message));
    this.logError =
      options.logError ??
      ((message, detail) =>
        detail === undefined ? console.error(message) : console.error(message, detail));
  }

  start(): void {
    this.connect();
  }

  /**
   * Sendet, falls die Verbindung steht. `false` = verworfen: der Host bricht
   * einen Turn bei einem Abriss seinerseits ab, die Claude-Session im SDK lebt
   * weiter — der Aufrufer entscheidet, ob das eine Meldung wert ist.
   */
  send(message: DaemonToHostMessage): boolean {
    return this.sendOn(this.socket, message);
  }

  private sendOn(socket: GatewaySocket | null, message: DaemonToHostMessage): boolean {
    if (socket === null || socket.readyState !== SOCKET_OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    const ws = this.createSocket(this.options.url);
    this.socket = ws;
    let stopPing: (() => void) | null = null;
    let unbeantwortetePings = 0;
    /** Verbindung schon abgebaut (close-Ereignis ODER Pong-Wächter)? */
    let abgebaut = false;

    const baueAb = (grund: string): void => {
      if (abgebaut) return;
      abgebaut = true;
      stopPing?.();
      if (this.socket === ws) this.socket = null;
      // Der Host hat den Turn bei einem Abriss seinerseits abgebrochen. Ohne
      // diesen Aufruf bliebe der Turn in der Session gesetzt und ihre
      // Notwehr-Sperre wiese ab da JEDEN Folge-Turn ab.
      this.options.session.abandonTurn();
      const delayMs = reconnectDelayMs(this.attempt);
      this.attempt += 1;
      this.logError(`Agent-Daemon: ${grund} — Reconnect in ${delayMs}ms`);
      this.schedule(() => this.connect(), delayMs);
    };

    ws.addEventListener('open', () => {
      this.log('Agent-Daemon: mit Host-Gateway verbunden');
      // Nach erfolgreichem Connect beginnt der Backoff wieder vorn.
      this.attempt = 0;
      this.sendOn(ws, { kind: 'ready' });
      stopPing = this.every(() => {
        // Pong-Wächter: verschluckt das VM-Netz den Abriss, kommt nie ein
        // close-Ereignis. Bleiben die Antworten aus, ist die Verbindung tot —
        // selbst abbauen, statt bis zum Aufgeben des TCP-Stacks zu warten.
        if (unbeantwortetePings >= MAX_UNBEANTWORTETE_PINGS) {
          baueAb('Gateway antwortet nicht auf Pings');
          try {
            ws.close();
          } catch (error) {
            this.logError('Agent-Daemon: Schließen der stummen Verbindung fehlgeschlagen:', error);
          }
          return;
        }
        if (this.sendOn(ws, { kind: 'ping' })) unbeantwortetePings += 1;
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener('message', (event) => {
      // Nachzügler einer bereits verworfenen Verbindung nicht mehr ausführen.
      if (abgebaut) return;
      const raw = typeof event.data === 'string' ? event.data : '';
      const message = parseHostToDaemon(raw);
      if (message === null) {
        this.logError('Agent-Daemon: unverständliche Host-Nachricht verworfen:', raw.slice(0, 200));
        return;
      }
      // Jede Nachricht des Hosts beweist, dass die Verbindung lebt.
      unbeantwortetePings = 0;
      // pong: Heartbeat-Antwort — hält den NAT-Flow in beide Richtungen aktiv.
      if (message.kind === 'pong') return;
      this.log(
        `Agent-Daemon: Kommando ${message.kind}` +
          ('turnId' in message ? ` (Turn ${message.turnId})` : ''),
      );
      this.dispatch(ws, message);
    });

    ws.addEventListener('close', () => {
      baueAb('Gateway-Verbindung weg');
    });

    ws.addEventListener('error', (event) => {
      // close folgt ohnehin — hier nur Diagnose.
      this.logError('Agent-Daemon: WebSocket-Fehler:', event);
    });
  }

  private dispatch(
    ws: GatewaySocket,
    message: Exclude<HostToDaemonMessage, { kind: 'pong' }>,
  ): void {
    try {
      if (message.kind === 'start-turn') {
        // Sofortige Quittung VOR dem Start: beweist dem Host, dass das
        // Kommando ankam (Schutz gegen halbtote Verbindungen nach
        // Daemon-Neustart).
        this.sendOn(ws, { kind: 'turn-started', turnId: message.turnId });
        this.options.session.startTurn(message);
      } else if (message.kind === 'interrupt') {
        this.options.session.interrupt(message.turnId);
      } else {
        this.logError('Agent-Daemon: Shutdown angefordert — Supervisor übernimmt den Neustart.');
        this.options.onShutdown();
      }
    } catch (error) {
      // Nie still scheitern — der Host würde sonst ewig warten.
      this.logError('Agent-Daemon: Kommando fehlgeschlagen:', error);
      if (message.kind === 'start-turn') {
        this.sendOn(ws, {
          kind: 'event',
          turnId: message.turnId,
          event: { type: 'error', message: `Daemon-Kommando fehlgeschlagen: ${String(error)}` },
        });
        this.sendOn(ws, { kind: 'event', turnId: message.turnId, event: { type: 'turn-aborted' } });
      }
    }
  }
}
