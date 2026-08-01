import type { AgentEvent } from '../events';
import type { PreviewStatus } from '../../preview/status';

/**
 * WS-Protokoll Host ↔ Agent-Daemon (in der VM). Der Daemon wählt sich beim
 * Host-Gateway ein (`/agent?sandbox=<name>&token=<secret>`); danach fließen
 * JSON-Nachrichten in beide Richtungen. Beide Seiten parsen defensiv —
 * eine kaputte Nachricht ergibt `null`, nie eine Exception.
 */

/** Pfad des Agent-Gateways am macvibes-Server. */
export const AGENT_GATEWAY_PATH = '/agent';

export type HostToDaemonMessage =
  | {
      kind: 'start-turn';
      turnId: string;
      prompt: string;
      /** Claude-Session zum Fortsetzen — null für frischen Start (Recovery-Politik liegt beim Host). */
      resumeSessionId: string | null;
      model: string;
    }
  | { kind: 'interrupt'; turnId: string }
  /** Antwort auf einen Daemon-ping — Liveness-Beweis für die Host→VM-Richtung. */
  | { kind: 'pong' }
  /**
   * Daemon soll sich beenden — der In-VM-Supervisor startet ihn frisch.
   * Nur der Daemon selbst kann das zuverlässig: msb-exec-Sessions leben in
   * eigenen PID-Namespaces und können den PID-1-Baum nicht killen.
   */
  | { kind: 'shutdown' };

export type DaemonToHostMessage =
  | { kind: 'ready' }
  /**
   * Heartbeat des Daemons: hält den NAT-Flow der VM→Host-Verbindung warm —
   * microsandbox lässt idle TCP-Flows still sterben, danach verschwinden
   * Kommandos spurlos (Live-Befund 2026-07-06).
   */
  | { kind: 'ping' }
  /**
   * Sofortige Quittung auf start-turn. Ohne sie weiß der Host nicht, ob das
   * Kommando ankam: nach einem Daemon-Neustart kann die registrierte
   * Verbindung halbtot sein (msb-NAT verschluckt FIN/RST — der Host-Socket
   * bleibt scheinbar offen) und Sends verschwinden spurlos (Live-Befund).
   */
  | { kind: 'turn-started'; turnId: string }
  /**
   * Der Daemon hat den Turn ABGELEHNT, weil er noch einen laufen sieht
   * (Notwehr-Sperre in `DaemonSession.startTurn`).
   *
   * Eine eigene Nachricht und kein blosser Fehlertext im Event-Strom: Der Host
   * serialisiert Turns pro Projekt: Sieht der Daemon trotzdem einen laufenden,
   * ist seine Sitzung verklemmt — etwa weil die SDK-Query haengt, ohne die
   * Verbindung zu verlieren (dann greift `abandonTurn` nicht). Aus diesem
   * Zustand kommt er nur durch einen Neustart heraus, und den kann nur er
   * selbst ausloesen (s. `shutdown`). Der Host muss die Ablehnung also
   * maschinell erkennen koennen, nicht nur anzeigen.
   */
  | { kind: 'turn-rejected'; turnId: string }
  | { kind: 'event'; turnId: string; event: AgentEvent }
  /**
   * Preview-Status aus der VM (ADR 0001): der Daemon liest monit lokal und
   * pusht über die bestehende Verbindung — kein monit-Port-Mapping mehr.
   */
  | { kind: 'preview-status'; status: PreviewStatus };

/** Wire-Whitelist — nichts Unbekanntes vom Netz durchreichen. */
const PREVIEW_STATUS_VALUES: readonly PreviewStatus[] = [
  'starting',
  'ready',
  'restarting',
  'failed',
  'stopped',
];

function isPreviewStatus(value: unknown): value is PreviewStatus {
  return typeof value === 'string' && (PREVIEW_STATUS_VALUES as readonly string[]).includes(value);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

export function parseHostToDaemon(raw: string): HostToDaemonMessage | null {
  const msg = parseJsonObject(raw);
  if (msg === null) return null;

  if (msg['kind'] === 'start-turn') {
    const resume = msg['resumeSessionId'];
    if (
      typeof msg['turnId'] === 'string' &&
      typeof msg['prompt'] === 'string' &&
      typeof msg['model'] === 'string' &&
      (typeof resume === 'string' || resume === null)
    ) {
      return {
        kind: 'start-turn',
        turnId: msg['turnId'],
        prompt: msg['prompt'],
        resumeSessionId: resume,
        model: msg['model'],
      };
    }
    return null;
  }

  if (msg['kind'] === 'interrupt' && typeof msg['turnId'] === 'string') {
    return { kind: 'interrupt', turnId: msg['turnId'] };
  }

  if (msg['kind'] === 'pong') {
    return { kind: 'pong' };
  }

  if (msg['kind'] === 'shutdown') {
    return { kind: 'shutdown' };
  }

  return null;
}

export function parseDaemonToHost(raw: string): DaemonToHostMessage | null {
  const msg = parseJsonObject(raw);
  if (msg === null) return null;

  if (msg['kind'] === 'ready') {
    return { kind: 'ready' };
  }

  if (msg['kind'] === 'ping') {
    return { kind: 'ping' };
  }

  // Auch die turnId ist ein Wire-String und wird gedeckelt — der Host führt
  // sie in Maps und schreibt sie in die DB.
  if (msg['kind'] === 'turn-started' && istKurzerString(msg['turnId'], MAX_ID_CHARS)) {
    return { kind: 'turn-started', turnId: msg['turnId'] };
  }

  if (msg['kind'] === 'turn-rejected' && istKurzerString(msg['turnId'], MAX_ID_CHARS)) {
    return { kind: 'turn-rejected', turnId: msg['turnId'] };
  }

  if (msg['kind'] === 'event' && istKurzerString(msg['turnId'], MAX_ID_CHARS)) {
    const event = parseAgentEvent(msg['event']);
    if (event === null) return null;
    return { kind: 'event', turnId: msg['turnId'], event };
  }

  if (msg['kind'] === 'preview-status' && isPreviewStatus(msg['status'])) {
    return { kind: 'preview-status', status: msg['status'] };
  }

  return null;
}

/** Obergrenze für einzelne Event-Texte aus der VM (F16, 1 MiB). */
const MAX_EVENT_TEXT_CHARS = 1_048_576;

/**
 * Obergrenzen für die übrigen Wire-Strings.
 *
 * Der F16-Deckel galt nur für text-/thinking-delta. Alle anderen Felder nahmen
 * Strings beliebiger Länge, und im Insert-Pfad des ChatService greift
 * MAX_MESSAGE_CHARS nicht — ein kompromittierter Daemon konnte damit Host-DB
 * und die Puffer aller Chat-Abonnenten sättigen. Die Werte orientieren sich an
 * dem, was echte Sender liefern: claudeRunner kürzt `detail` selbst auf 300
 * Zeichen, Session-IDs sind UUIDs.
 */
const MAX_TOOL_NAME_CHARS = 256;
const MAX_TOOL_DETAIL_CHARS = 4096;
const MAX_EVENT_MESSAGE_CHARS = 8192;
const MAX_ID_CHARS = 128;

/** Ein plausibler Zähler: kleine, nicht-negative Ganzzahl. */
function istZaehler(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000;
}

function istKurzerString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

/**
 * Validiert ein über die Leitung gekommenes AgentEvent strukturell und baut
 * es frisch auf (keine Fremd-Felder aus dem Netz weiterreichen).
 */
function parseAgentEvent(value: unknown): AgentEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;

  switch (e['type']) {
    case 'text-delta':
    case 'thinking-delta':
      // Länge begrenzen (F16): der Daemon ist nicht vertrauenswürdig, und ein
      // einzelnes Riesen-Delta würde den Deckel im ChatService unterlaufen.
      if (typeof e['text'] !== 'string' || e['text'].length > MAX_EVENT_TEXT_CHARS) return null;
      return { type: e['type'], text: e['text'] };
    case 'block-stop':
      return { type: 'block-stop' };
    case 'turn-aborted':
      return { type: 'turn-aborted' };
    case 'tool-use':
      if (
        !istKurzerString(e['name'], MAX_TOOL_NAME_CHARS) ||
        !istKurzerString(e['detail'], MAX_TOOL_DETAIL_CHARS)
      ) {
        return null;
      }
      return { type: 'tool-use', name: e['name'], detail: e['detail'] };
    case 'session':
      if (!istKurzerString(e['sessionId'], MAX_ID_CHARS)) return null;
      return { type: 'session', sessionId: e['sessionId'] };
    case 'api-retry':
      if (
        !istZaehler(e['attempt']) ||
        !istZaehler(e['maxRetries']) ||
        !istKurzerString(e['message'], MAX_EVENT_MESSAGE_CHARS)
      ) {
        return null;
      }
      return {
        type: 'api-retry',
        attempt: e['attempt'],
        maxRetries: e['maxRetries'],
        message: e['message'],
      };
    case 'turn-completed': {
      const sessionId = e['sessionId'];
      if (sessionId !== null && !istKurzerString(sessionId, MAX_ID_CHARS)) return null;
      return { type: 'turn-completed', sessionId };
    }
    case 'error':
      if (!istKurzerString(e['message'], MAX_EVENT_MESSAGE_CHARS)) return null;
      return { type: 'error', message: e['message'] };
    default:
      return null;
  }
}
