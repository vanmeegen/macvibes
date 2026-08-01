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

/**
 * F16: Der Daemon ist nicht vertrauenswürdig. Ein einzelnes Riesen-Delta
 * würde den Zeilen-Deckel des ChatService unterlaufen.
 */
describe('parseDaemonToHost — Längengrenze für Event-Texte (F16)', () => {
  function eventMessage(text: string): string {
    return JSON.stringify({ kind: 'event', turnId: 't1', event: { type: 'text-delta', text } });
  }

  test('normale Deltas kommen durch', () => {
    expect(parseDaemonToHost(eventMessage('Hallo'))).not.toBeNull();
  });

  test('ein Delta über 1 MiB wird verworfen', () => {
    expect(parseDaemonToHost(eventMessage('x'.repeat(1_048_577)))).toBeNull();
  });
});

/**
 * Der F16-Deckel griff nur für text-/thinking-delta. tool-use, session,
 * api-retry, error und turn-completed nahmen Strings beliebiger Länge — ein
 * kompromittierter Daemon konnte damit die Host-DB und die Puffer aller
 * Chat-Abonnenten sättigen, denn im Insert-Pfad gilt MAX_MESSAGE_CHARS nicht.
 */
describe('parseDaemonToHost — Längengrenzen für ALLE Wire-Strings', () => {
  function ereignis(event: Record<string, unknown>): string {
    return JSON.stringify({ kind: 'event', turnId: 't1', event });
  }
  const riesig = 'x'.repeat(2_000_000);

  test('tool-use mit riesigem name oder detail wird verworfen', () => {
    expect(parseDaemonToHost(ereignis({ type: 'tool-use', name: riesig, detail: '' }))).toBeNull();
    expect(
      parseDaemonToHost(ereignis({ type: 'tool-use', name: 'Bash', detail: riesig })),
    ).toBeNull();
  });

  test('normale tool-use-Events kommen weiterhin durch', () => {
    expect(
      parseDaemonToHost(ereignis({ type: 'tool-use', name: 'Bash', detail: 'ls -la' })),
    ).not.toBeNull();
  });

  test('error mit riesiger message wird verworfen', () => {
    expect(parseDaemonToHost(ereignis({ type: 'error', message: riesig }))).toBeNull();
    expect(parseDaemonToHost(ereignis({ type: 'error', message: 'kaputt' }))).not.toBeNull();
  });

  test('api-retry mit riesiger message wird verworfen', () => {
    const basis = { type: 'api-retry', attempt: 1, maxRetries: 3 };
    expect(parseDaemonToHost(ereignis({ ...basis, message: riesig }))).toBeNull();
    expect(parseDaemonToHost(ereignis({ ...basis, message: 'überlastet' }))).not.toBeNull();
  });

  test('api-retry mit unsinnigen Zählern wird verworfen', () => {
    const m = { type: 'api-retry', message: 'x' };
    expect(parseDaemonToHost(ereignis({ ...m, attempt: -1, maxRetries: 3 }))).toBeNull();
    expect(parseDaemonToHost(ereignis({ ...m, attempt: 1e9, maxRetries: 3 }))).toBeNull();
    expect(parseDaemonToHost(ereignis({ ...m, attempt: 1.5, maxRetries: 3 }))).toBeNull();
    expect(parseDaemonToHost(ereignis({ ...m, attempt: 1, maxRetries: 3 }))).not.toBeNull();
  });

  test('session/turn-completed mit riesiger sessionId wird verworfen', () => {
    expect(parseDaemonToHost(ereignis({ type: 'session', sessionId: riesig }))).toBeNull();
    expect(parseDaemonToHost(ereignis({ type: 'turn-completed', sessionId: riesig }))).toBeNull();
    // Eine echte Session-ID ist eine UUID — die bleibt gültig.
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(parseDaemonToHost(ereignis({ type: 'session', sessionId: uuid }))).not.toBeNull();
    expect(parseDaemonToHost(ereignis({ type: 'turn-completed', sessionId: null }))).not.toBeNull();
  });

  test('eine riesige turnId wird verworfen', () => {
    const rohes = JSON.stringify({
      kind: 'event',
      turnId: riesig,
      event: { type: 'block-stop' },
    });
    expect(parseDaemonToHost(rohes)).toBeNull();
  });
});

/**
 * Die Notwehr-Sperre des Daemons („es läuft bereits ein Turn") ist der einzige
 * Zustand, aus dem der Host ihn nicht selbst herausholen konnte. Damit er
 * darauf reagieren KANN, meldet der Daemon die Ablehnung ausdrücklich — statt
 * sie nur als Fehlertext in den Event-Strom zu legen, den niemand
 * maschinenlesbar auswerten kann.
 */
describe('turn-rejected (Daemon → Host)', () => {
  test('wird als eigene Nachricht erkannt', () => {
    expect(parseDaemonToHost(JSON.stringify({ kind: 'turn-rejected', turnId: 't-1' }))).toEqual({
      kind: 'turn-rejected',
      turnId: 't-1',
    });
  });

  test('ohne turnId ist die Nachricht wertlos und wird verworfen', () => {
    expect(parseDaemonToHost(JSON.stringify({ kind: 'turn-rejected' }))).toBeNull();
    expect(parseDaemonToHost(JSON.stringify({ kind: 'turn-rejected', turnId: 7 }))).toBeNull();
  });
});
