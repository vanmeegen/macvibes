import { describe, expect, test } from 'bun:test';
import { parseStreamJsonLine } from '../claudeStreamJson';

describe('parseStreamJsonLine', () => {
  test('ignoriert leere und kaputte Zeilen', () => {
    expect(parseStreamJsonLine('')).toEqual([]);
    expect(parseStreamJsonLine('   ')).toEqual([]);
    expect(parseStreamJsonLine('{ kaputt')).toEqual([]);
    expect(parseStreamJsonLine('42')).toEqual([]);
  });

  test('system/init liefert die Session-ID', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    expect(parseStreamJsonLine(line)).toEqual([{ type: 'session', sessionId: 'sess-1' }]);
  });

  test('Text-Deltas werden durchgereicht, leere ignoriert', () => {
    const delta = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hallo' } },
    });
    expect(parseStreamJsonLine(delta)).toEqual([{ type: 'text-delta', text: 'Hallo' }]);

    const empty = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } },
    });
    expect(parseStreamJsonLine(empty)).toEqual([]);
  });

  test('Tool-Call erscheint SOFORT beim content_block_start (nicht erst am Blockende)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
      },
    });
    const events = parseStreamJsonLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool-use', name: 'Read' });
  });

  test('der komplette assistant-Block dupliziert den Tool-Call NICHT', () => {
    // Er kam schon per content_block_start — sonst stünde jedes Tool doppelt im Chat.
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Write', input: { path: 'a.ts' } }] },
    });
    expect(parseStreamJsonLine(line)).toEqual([]);
  });

  test('content_block_stop signalisiert eine Blockgrenze (trennt Text vor/nach einem Tool)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    });
    expect(parseStreamJsonLine(line)).toEqual([{ type: 'block-stop' }]);
  });

  test('thinking_delta wird als Denk-Stream durchgereicht (falls die API es liefert)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'Ich überlege…' },
      },
    });
    expect(parseStreamJsonLine(line)).toEqual([{ type: 'thinking-delta', text: 'Ich überlege…' }]);
  });

  test('result/success liefert turn-completed mit Session-ID', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-9' });
    expect(parseStreamJsonLine(line)).toEqual([{ type: 'turn-completed', sessionId: 'sess-9' }]);
  });

  test('result-Fehler liefert error + turn-aborted', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns' });
    const events = parseStreamJsonLine(line);
    expect(events[0]?.type).toBe('error');
    expect(events[1]).toEqual({ type: 'turn-aborted' });
  });

  test('api_retry wird sichtbar gemacht statt verschluckt (Live-Bug 2026-07-04)', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      attempt: 3,
      max_retries: 10,
      error_status: 401,
      error: 'authentication_failed',
    });
    const events = parseStreamJsonLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'api-retry',
      attempt: 3,
      maxRetries: 10,
      message: 'authentication_failed (Status 401)',
    });
  });
});
