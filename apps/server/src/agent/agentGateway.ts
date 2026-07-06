import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import { AGENT_GATEWAY_PATH, parseDaemonToHost } from './daemon/protocol';
import type { DaemonToHostMessage, HostToDaemonMessage } from './daemon/protocol';

export { AGENT_GATEWAY_PATH };

/** Was ein Gateway-Nutzer (DaemonAgentRunner) pro Sandbox mitbekommt. */
export type GatewayNotification =
  { kind: 'message'; message: DaemonToHostMessage } | { kind: 'disconnected' };

export type GatewayListener = (notification: GatewayNotification) => void;

export interface GatewaySocketData {
  sandbox: string;
}

/**
 * Host-seitiges WS-Gateway für die Agent-Daemons in den VMs. Jeder Daemon
 * wählt sich AUSGEHEND ein (`/agent?sandbox=<name>&token=<secret>` über
 * host.microsandbox.internal) — kein Port-Forwarding in die VM nötig.
 * Auth über dasselbe Shared Secret wie der Credential-Proxy.
 */
export class AgentGateway {
  private readonly token: string;
  private readonly connections = new Map<string, ServerWebSocket<GatewaySocketData>>();
  private readonly listeners = new Map<string, Set<GatewayListener>>();
  private readonly connectWaiters = new Map<string, Set<() => void>>();

  constructor(options: { token: string }) {
    this.token = options.token;
  }

  /** Upgrade-Handler für index.ts — undefined, wenn der Socket übernommen wurde. */
  handleUpgrade(request: Request, server: Server<GatewaySocketData>): Response | undefined {
    const url = new URL(request.url);
    const sandbox = url.searchParams.get('sandbox');
    const token = url.searchParams.get('token');
    if (token !== this.token) {
      return new Response('Ungültiges Gateway-Token', { status: 401 });
    }
    if (sandbox === null || sandbox.length === 0) {
      return new Response('sandbox-Parameter fehlt', { status: 400 });
    }
    const data: GatewaySocketData = { sandbox };
    if (server.upgrade(request, { data })) {
      return undefined;
    }
    return new Response('WebSocket-Upgrade fehlgeschlagen', { status: 400 });
  }

  /** WebSocket-Handler für Bun.serve. */
  get websocket(): WebSocketHandler<GatewaySocketData> {
    return {
      open: (ws) => this.onOpen(ws),
      message: (ws, raw) => this.onMessage(ws, raw),
      close: (ws, code, reason) => this.onClose(ws, code, reason),
    };
  }

  isConnected(sandbox: string): boolean {
    return this.connections.has(sandbox);
  }

  /** Wartet, bis sich der Daemon der Sandbox eingewählt hat. */
  async waitForConnection(sandbox: string, timeoutMs: number): Promise<void> {
    if (this.connections.has(sandbox)) return;
    await new Promise<void>((resolve, reject) => {
      const waiters = this.connectWaiters.get(sandbox) ?? new Set();
      this.connectWaiters.set(sandbox, waiters);
      const timer = setTimeout(() => {
        waiters.delete(onConnect);
        reject(new Error(`Agent-Daemon von ${sandbox} hat sich nicht verbunden (${timeoutMs}ms)`));
      }, timeoutMs);
      const onConnect = (): void => {
        clearTimeout(timer);
        resolve();
      };
      waiters.add(onConnect);
    });
  }

  /** Schickt ein Kommando an den Daemon; false, wenn nicht verbunden. */
  send(sandbox: string, message: HostToDaemonMessage): boolean {
    const ws = this.connections.get(sandbox);
    if (ws === undefined) return false;
    // Bun: Rückgabe -1 = Backpressure, 0 = verworfen (Socket zu), >0 = Bytes raus.
    const result = ws.send(JSON.stringify(message));
    if (result <= 0) {
      console.error(`Agent-Gateway: send(${message.kind}) an ${sandbox} → Ergebnis ${result}`);
    }
    return true;
  }

  /**
   * Verwirft die registrierte Verbindung einer Sandbox (mutmaßlich halbtot —
   * msb-NAT verschluckt FIN/RST, der Socket bleibt scheinbar offen). Der
   * Daemon-Reconnect registriert danach eine frische Verbindung.
   */
  invalidate(sandbox: string): void {
    const ws = this.connections.get(sandbox);
    if (ws === undefined) return;
    this.connections.delete(sandbox);
    console.error(`Agent-Gateway: Verbindung von ${sandbox} verworfen (keine Quittung)`);
    // terminate: kein Close-Handshake — der Gegenüber ist mutmaßlich weg.
    ws.terminate();
  }

  /** Abonniert Nachrichten/Disconnects einer Sandbox; Rückgabe: Abbestellen. */
  subscribe(sandbox: string, listener: GatewayListener): () => void {
    const set = this.listeners.get(sandbox) ?? new Set();
    this.listeners.set(sandbox, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  private onOpen(ws: ServerWebSocket<GatewaySocketData>): void {
    const { sandbox } = ws.data;
    const previous = this.connections.get(sandbox);
    console.log(
      `Agent-Gateway: ${sandbox} verbunden (ersetzt alte Verbindung: ${previous !== undefined ? 'ja' : 'nein'}, ${new Date().toISOString().slice(11, 19)})`,
    );
    // ERST die neue Verbindung registrieren, DANN die alte schließen: liefert
    // Bun den close-Callback synchron, sähe onClose sonst noch die alte als
    // registriert und feuerte ein falsches "disconnected" für die Sandbox.
    this.connections.set(sandbox, ws);
    if (previous !== undefined) {
      // Daemon-Neustart: die neue Verbindung gilt, die alte ist tot.
      previous.close(4000, 'Ersetzt durch neue Daemon-Verbindung');
    }
    const waiters = this.connectWaiters.get(sandbox);
    if (waiters !== undefined) {
      this.connectWaiters.delete(sandbox);
      for (const resolve of waiters) resolve();
    }
  }

  private onMessage(ws: ServerWebSocket<GatewaySocketData>, raw: string | Buffer): void {
    const message = parseDaemonToHost(typeof raw === 'string' ? raw : raw.toString('utf8'));
    if (message === null) {
      console.error(`Agent-Gateway: unverständliche Daemon-Nachricht von ${ws.data.sandbox}`);
      return;
    }
    // Heartbeat dient nur dem NAT-Warmhalten — nicht an Abonnenten durchreichen.
    // Die pong-Antwort hält auch die Host→VM-Richtung des Flows aktiv.
    if (message.kind === 'ping') {
      ws.send(JSON.stringify({ kind: 'pong' }));
      return;
    }
    this.notify(ws.data.sandbox, { kind: 'message', message });
  }

  private onClose(ws: ServerWebSocket<GatewaySocketData>, code?: number, reason?: string): void {
    const { sandbox } = ws.data;
    // Nur die aktuell registrierte Verbindung meldet einen Disconnect —
    // eine ersetzte (Reconnect) darf den neuen Daemon nicht "trennen".
    if (this.connections.get(sandbox) !== ws) return;
    this.connections.delete(sandbox);
    console.error(`Agent-Gateway: ${sandbox} getrennt (Code ${code ?? '?'}, ${reason ?? ''})`);
    this.notify(sandbox, { kind: 'disconnected' });
  }

  private notify(sandbox: string, notification: GatewayNotification): void {
    const set = this.listeners.get(sandbox);
    if (set === undefined) return;
    for (const listener of [...set]) {
      listener(notification);
    }
  }
}
