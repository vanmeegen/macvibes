import type { AgentEvent } from './events';

/**
 * Übersetzt eine einzelne stream-json-Zeile des Claude-Code-CLI
 * (`--output-format stream-json`) in AgentEvents. Unbekannte/leere Zeilen
 * ergeben ein leeres Array. Wird sowohl vom VM-Runner (msb exec) als auch
 * in Tests genutzt.
 */
export function parseStreamJsonLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (typeof message !== 'object' || message === null) return [];
  const msg = message as Record<string, unknown>;

  switch (msg['type']) {
    case 'system':
      if (msg['subtype'] === 'init' && typeof msg['session_id'] === 'string') {
        return [{ type: 'session', sessionId: msg['session_id'] }];
      }
      if (msg['subtype'] === 'api_retry') {
        // Nie verschlucken — sonst sieht ein API-Problem wie ein Hänger aus.
        const errorName = typeof msg['error'] === 'string' ? msg['error'] : 'unbekannt';
        const status = msg['error_status'];
        return [
          {
            type: 'api-retry',
            attempt: typeof msg['attempt'] === 'number' ? msg['attempt'] : 0,
            maxRetries: typeof msg['max_retries'] === 'number' ? msg['max_retries'] : 0,
            message: typeof status === 'number' ? `${errorName} (Status ${status})` : errorName,
          },
        ];
      }
      return [];
    case 'stream_event':
      return parseStreamEvent(msg['event']);
    case 'assistant':
      return parseAssistant(msg['message']);
    case 'result':
      return parseResult(msg);
    default:
      return [];
  }
}

function parseStreamEvent(event: unknown): AgentEvent[] {
  if (typeof event !== 'object' || event === null) return [];
  const ev = event as Record<string, unknown>;
  if (ev['type'] !== 'content_block_delta') return [];
  const delta = ev['delta'];
  if (typeof delta !== 'object' || delta === null) return [];
  const d = delta as Record<string, unknown>;
  if (d['type'] === 'text_delta' && typeof d['text'] === 'string' && d['text'].length > 0) {
    return [{ type: 'text-delta', text: d['text'] }];
  }
  return [];
}

function parseAssistant(message: unknown): AgentEvent[] {
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return [];
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
        events.push({
          type: 'tool-use',
          name: b['name'],
          detail: JSON.stringify(b['input']).slice(0, 300),
        });
      }
    }
  }
  return events;
}

function parseResult(msg: Record<string, unknown>): AgentEvent[] {
  const sessionId = typeof msg['session_id'] === 'string' ? msg['session_id'] : null;
  if (msg['subtype'] === 'success') {
    return [{ type: 'turn-completed', sessionId }];
  }
  return [
    { type: 'error', message: `Agent-Turn fehlgeschlagen (${String(msg['subtype'])})` },
    { type: 'turn-aborted' },
  ];
}
