import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '../../events';
import { parseDaemonToHost, parseHostToDaemon } from '../protocol';

describe('parseHostToDaemon', () => {
  test('start-turn wird vollständig geparst', () => {
    const raw = JSON.stringify({
      kind: 'start-turn',
      turnId: 't-1',
      prompt: 'Baue eine Todo-App',
      resumeSessionId: 'sess-1',
      model: 'claude-sonnet-5',
    });
    expect(parseHostToDaemon(raw)).toEqual({
      kind: 'start-turn',
      turnId: 't-1',
      prompt: 'Baue eine Todo-App',
      resumeSessionId: 'sess-1',
      model: 'claude-sonnet-5',
    });
  });

  test('start-turn mit resumeSessionId null (frischer Start)', () => {
    const raw = JSON.stringify({
      kind: 'start-turn',
      turnId: 't-2',
      prompt: 'weiter',
      resumeSessionId: null,
      model: 'claude-sonnet-5',
    });
    expect(parseHostToDaemon(raw)?.kind).toBe('start-turn');
  });

  test('interrupt wird geparst', () => {
    const raw = JSON.stringify({ kind: 'interrupt', turnId: 't-1' });
    expect(parseHostToDaemon(raw)).toEqual({ kind: 'interrupt', turnId: 't-1' });
  });

  test('shutdown wird geparst (Daemon beendet sich selbst, Supervisor startet neu)', () => {
    expect(parseHostToDaemon(JSON.stringify({ kind: 'shutdown' }))).toEqual({ kind: 'shutdown' });
  });

  test('kaputte/unbekannte Nachrichten ergeben null, keine Exception', () => {
    expect(parseHostToDaemon('{ kaputt')).toBeNull();
    expect(parseHostToDaemon('42')).toBeNull();
    expect(parseHostToDaemon(JSON.stringify({ kind: 'unbekannt' }))).toBeNull();
    // start-turn ohne Pflichtfelder ist ungültig
    expect(parseHostToDaemon(JSON.stringify({ kind: 'start-turn', turnId: 't' }))).toBeNull();
    expect(
      parseHostToDaemon(
        JSON.stringify({ kind: 'start-turn', turnId: 't', prompt: 'x', model: 'm' }),
      ),
    ).toBeNull();
  });
});

describe('parseDaemonToHost', () => {
  test('ready wird geparst', () => {
    expect(parseDaemonToHost(JSON.stringify({ kind: 'ready' }))).toEqual({ kind: 'ready' });
  });

  test('ping (NAT-Heartbeat) wird geparst', () => {
    expect(parseDaemonToHost(JSON.stringify({ kind: 'ping' }))).toEqual({ kind: 'ping' });
  });

  test('event-Nachricht mit AgentEvent wird geparst', () => {
    const raw = JSON.stringify({
      kind: 'event',
      turnId: 't-1',
      event: { type: 'text-delta', text: 'Hallo' },
    });
    expect(parseDaemonToHost(raw)).toEqual({
      kind: 'event',
      turnId: 't-1',
      event: { type: 'text-delta', text: 'Hallo' },
    });
  });

  test('alle terminalen und Meta-Events passieren die Validierung', () => {
    const events: AgentEvent[] = [
      { type: 'thinking-delta', text: 'hm' },
      { type: 'block-stop' },
      { type: 'tool-use', name: 'Read', detail: '' },
      { type: 'session', sessionId: 's-1' },
      { type: 'api-retry', attempt: 1, maxRetries: 3, message: 'überlastet' },
      { type: 'turn-completed', sessionId: 's-1' },
      { type: 'turn-completed', sessionId: null },
      { type: 'turn-aborted' },
      { type: 'error', message: 'kaputt' },
    ];
    for (const event of events) {
      const raw = JSON.stringify({ kind: 'event', turnId: 't', event });
      expect(parseDaemonToHost(raw)).toEqual({ kind: 'event', turnId: 't', event });
    }
  });

  test('preview-status wird geparst (ADR 0001: Status über die Daemon-Verbindung)', () => {
    expect(parseDaemonToHost(JSON.stringify({ kind: 'preview-status', status: 'ready' }))).toEqual({
      kind: 'preview-status',
      status: 'ready',
    });
    expect(
      parseDaemonToHost(JSON.stringify({ kind: 'preview-status', status: 'restarting' })),
    ).toEqual({ kind: 'preview-status', status: 'restarting' });
    expect(parseDaemonToHost(JSON.stringify({ kind: 'preview-status', status: 'failed' }))).toEqual(
      { kind: 'preview-status', status: 'failed' },
    );
  });

  test('preview-status mit unbekanntem Status ergibt null (nichts vom Netz durchreichen)', () => {
    expect(
      parseDaemonToHost(JSON.stringify({ kind: 'preview-status', status: 'explodiert' })),
    ).toBeNull();
    expect(parseDaemonToHost(JSON.stringify({ kind: 'preview-status' }))).toBeNull();
  });

  test('unbekannte Event-Typen und kaputte Nachrichten ergeben null', () => {
    expect(parseDaemonToHost('{ kaputt')).toBeNull();
    expect(
      parseDaemonToHost(JSON.stringify({ kind: 'event', turnId: 't', event: { type: 'geheim' } })),
    ).toBeNull();
    expect(parseDaemonToHost(JSON.stringify({ kind: 'event', turnId: 't' }))).toBeNull();
    // text-delta ohne text ist ungültig
    expect(
      parseDaemonToHost(
        JSON.stringify({ kind: 'event', turnId: 't', event: { type: 'text-delta' } }),
      ),
    ).toBeNull();
  });
});
