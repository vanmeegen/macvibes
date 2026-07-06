import type { AgentEvent } from '../events';

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
  | { kind: 'interrupt'; turnId: string };

export type DaemonToHostMessage =
  { kind: 'ready' } | { kind: 'event'; turnId: string; event: AgentEvent };

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

  return null;
}

export function parseDaemonToHost(raw: string): DaemonToHostMessage | null {
  const msg = parseJsonObject(raw);
  if (msg === null) return null;

  if (msg['kind'] === 'ready') {
    return { kind: 'ready' };
  }

  if (msg['kind'] === 'event' && typeof msg['turnId'] === 'string') {
    const event = parseAgentEvent(msg['event']);
    if (event === null) return null;
    return { kind: 'event', turnId: msg['turnId'], event };
  }

  return null;
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
      if (typeof e['text'] !== 'string') return null;
      return { type: e['type'], text: e['text'] };
    case 'block-stop':
      return { type: 'block-stop' };
    case 'turn-aborted':
      return { type: 'turn-aborted' };
    case 'tool-use':
      if (typeof e['name'] !== 'string' || typeof e['detail'] !== 'string') return null;
      return { type: 'tool-use', name: e['name'], detail: e['detail'] };
    case 'session':
      if (typeof e['sessionId'] !== 'string') return null;
      return { type: 'session', sessionId: e['sessionId'] };
    case 'api-retry':
      if (
        typeof e['attempt'] !== 'number' ||
        typeof e['maxRetries'] !== 'number' ||
        typeof e['message'] !== 'string'
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
      if (typeof sessionId !== 'string' && sessionId !== null) return null;
      return { type: 'turn-completed', sessionId };
    }
    case 'error':
      if (typeof e['message'] !== 'string') return null;
      return { type: 'error', message: e['message'] };
    default:
      return null;
  }
}
