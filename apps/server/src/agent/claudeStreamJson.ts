import type { AgentEvent } from './events';

/**
 * Mapping SDK-Message (`query()`-Stream, formgleich mit den früheren
 * CLI-stream-json-Zeilen) → AgentEvents. Genutzt vom Agent-Daemon in der VM.
 */
export function agentEventsFromMessage(message: unknown): AgentEvent[] {
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
    // 'assistant' liefert den fertigen Block — Tools kamen bereits live per
    // content_block_start, Text per text_delta. Nicht nochmal ausgeben (Duplikat).
    case 'assistant':
      return [];
    case 'result':
      return parseResult(msg);
    default:
      return [];
  }
}

function parseStreamEvent(event: unknown): AgentEvent[] {
  if (typeof event !== 'object' || event === null) return [];
  const ev = event as Record<string, unknown>;

  // Blockende — die nächste Text-/Denk-Sequenz beginnt eine neue Bubble
  // (sonst kleben Text vor und nach einem Tool-Call zusammen).
  if (ev['type'] === 'content_block_stop') {
    return [{ type: 'block-stop' }];
  }

  // Ein Tool-Call beginnt — sofort anzeigen, nicht erst wenn der Block fertig ist.
  if (ev['type'] === 'content_block_start') {
    const block = ev['content_block'];
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
        return [{ type: 'tool-use', name: b['name'], detail: '' }];
      }
    }
    return [];
  }

  if (ev['type'] === 'content_block_delta') {
    const delta = ev['delta'];
    if (typeof delta !== 'object' || delta === null) return [];
    const d = delta as Record<string, unknown>;
    if (d['type'] === 'text_delta' && typeof d['text'] === 'string' && d['text'].length > 0) {
      return [{ type: 'text-delta', text: d['text'] }];
    }
    // Denken live streamen — sofern die API es im Klartext liefert (oft leer/verschlüsselt).
    if (
      d['type'] === 'thinking_delta' &&
      typeof d['thinking'] === 'string' &&
      d['thinking'].length > 0
    ) {
      return [{ type: 'thinking-delta', text: d['thinking'] }];
    }
  }
  return [];
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
