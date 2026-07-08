import { describe, expect, test } from 'bun:test';
import { agentEventsFromMessage } from '../claudeStreamJson';

describe('agentEventsFromMessage (SDK-Messages → AgentEvents, Daemon-Pfad)', () => {
  test('ignoriert Nicht-Objekte und unbekannte Typen', () => {
    expect(agentEventsFromMessage(null)).toEqual([]);
    expect(agentEventsFromMessage(42)).toEqual([]);
    expect(agentEventsFromMessage({ type: 'unbekannt' })).toEqual([]);
  });

  test('system/init liefert die Session-ID', () => {
    expect(
      agentEventsFromMessage({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    ).toEqual([{ type: 'session', sessionId: 'sess-1' }]);
  });

  test('Text-Deltas werden durchgereicht, leere ignoriert', () => {
    expect(
      agentEventsFromMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hallo' } },
      }),
    ).toEqual([{ type: 'text-delta', text: 'Hallo' }]);

    expect(
      agentEventsFromMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
      }),
    ).toEqual([]);
  });

  test('Tool-Call erscheint SOFORT beim content_block_start (nicht erst am Blockende)', () => {
    const events = agentEventsFromMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool-use', name: 'Read' });
  });

  test('der komplette assistant-Block dupliziert den Tool-Call NICHT', () => {
    // Er kam schon per content_block_start — sonst stünde jedes Tool doppelt im Chat.
    expect(
      agentEventsFromMessage({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { path: 'a.ts' } }] },
      }),
    ).toEqual([]);
  });

  test('content_block_stop signalisiert eine Blockgrenze (trennt Text vor/nach einem Tool)', () => {
    expect(
      agentEventsFromMessage({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }),
    ).toEqual([{ type: 'block-stop' }]);
  });

  test('thinking_delta wird als Denk-Stream durchgereicht (falls die API es liefert)', () => {
    expect(
      agentEventsFromMessage({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: 'Ich überlege…' },
        },
      }),
    ).toEqual([{ type: 'thinking-delta', text: 'Ich überlege…' }]);
  });

  test('result/success liefert turn-completed mit Session-ID', () => {
    expect(
      agentEventsFromMessage({ type: 'result', subtype: 'success', session_id: 'sess-9' }),
    ).toEqual([{ type: 'turn-completed', sessionId: 'sess-9' }]);
  });

  test('result-Fehler liefert error + turn-aborted', () => {
    const events = agentEventsFromMessage({ type: 'result', subtype: 'error_max_turns' });
    expect(events[0]?.type).toBe('error');
    expect(events[1]).toEqual({ type: 'turn-aborted' });
  });

  test('api_retry wird sichtbar gemacht statt verschluckt (Live-Bug 2026-07-04)', () => {
    const events = agentEventsFromMessage({
      type: 'system',
      subtype: 'api_retry',
      attempt: 3,
      max_retries: 10,
      error_status: 401,
      error: 'authentication_failed',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'api-retry',
      attempt: 3,
      maxRetries: 10,
      message: 'authentication_failed (Status 401)',
    });
  });
});
