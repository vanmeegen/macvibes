import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '../../events';
import { DaemonSession } from '../daemonSession';
import type { DaemonToHostMessage } from '../protocol';
import type { QueryHandle, QueryParams, SdkUserMessage } from '../daemonSession';

/** Steuerbare Fake-Query: Test schiebt SDK-Messages rein, Daemon konsumiert. */
class FakeQuery implements QueryHandle {
  readonly promptMessages: SdkUserMessage[] = [];
  interruptCalls = 0;
  private queue: unknown[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  private failure: Error | null = null;

  constructor(prompt: AsyncIterable<SdkUserMessage>) {
    // Wie das echte SDK: die Prompt-Quelle im Hintergrund konsumieren.
    void (async () => {
      for await (const message of prompt) {
        this.promptMessages.push(message);
      }
    })();
  }

  push(message: unknown): void {
    this.queue.push(message);
    this.waiter?.();
  }

  end(): void {
    this.ended = true;
    this.waiter?.();
  }

  fail(error: Error): void {
    this.failure = error;
    this.waiter?.();
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      while (this.queue.length > 0) {
        yield this.queue.shift();
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
  }
}

interface Harness {
  session: DaemonSession;
  emitted: DaemonToHostMessage[];
  queries: FakeQuery[];
  queryParams: QueryParams[];
}

function makeHarness(): Harness {
  const emitted: DaemonToHostMessage[] = [];
  const queries: FakeQuery[] = [];
  const queryParams: QueryParams[] = [];
  const session = new DaemonSession({
    cwd: '/work',
    emit: (message) => emitted.push(message),
    createQuery: (params) => {
      queryParams.push(params);
      const q = new FakeQuery(params.prompt);
      queries.push(q);
      return q;
    },
  });
  return { session, emitted, queries, queryParams };
}

/** Event-Nachrichten eines Turns aus dem emit-Protokoll ziehen. */
function eventsFor(emitted: DaemonToHostMessage[], turnId: string): AgentEvent[] {
  return emitted.flatMap((m) => (m.kind === 'event' && m.turnId === turnId ? [m.event] : []));
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Bun.sleep(0);
  }
}

const START = {
  turnId: 't-1',
  prompt: 'Baue eine Todo-App',
  resumeSessionId: null,
  model: 'claude-sonnet-5',
};

describe('DaemonSession', () => {
  test('startTurn erzeugt die Query mit cwd/model/resume und schiebt den Prompt hinein', async () => {
    const h = makeHarness();
    h.session.startTurn({ ...START, resumeSessionId: 'sess-alt' });
    await tick();

    expect(h.queryParams).toHaveLength(1);
    expect(h.queryParams[0]).toMatchObject({
      cwd: '/work',
      model: 'claude-sonnet-5',
      resumeSessionId: 'sess-alt',
    });
    expect(h.queries[0]?.promptMessages).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: 'Baue eine Todo-App' },
        parent_tool_use_id: null,
      },
    ]);
  });

  test('SDK-Messages werden als AgentEvents mit turnId emittiert', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();

    const q = h.queries[0]!;
    q.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    q.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hallo' } },
    });
    q.push({ type: 'result', subtype: 'success', session_id: 'sess-1' });
    await tick();

    expect(eventsFor(h.emitted, 't-1')).toEqual([
      { type: 'session', sessionId: 'sess-1' },
      { type: 'text-delta', text: 'Hallo' },
      { type: 'turn-completed', sessionId: 'sess-1' },
    ]);
  });

  test('der zweite Turn nutzt DIESELBE Query weiter (kein resume, kein Neuaufbau)', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();
    h.queries[0]!.push({ type: 'result', subtype: 'success', session_id: 'sess-1' });
    await tick();

    h.session.startTurn({ ...START, turnId: 't-2', prompt: 'weiter', resumeSessionId: 'sess-1' });
    await tick();

    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]!.promptMessages).toHaveLength(2);
    expect(h.queries[0]!.promptMessages[1]?.message.content).toBe('weiter');

    h.queries[0]!.push({ type: 'result', subtype: 'success', session_id: 'sess-1' });
    await tick();
    expect(eventsFor(h.emitted, 't-2')).toEqual([{ type: 'turn-completed', sessionId: 'sess-1' }]);
  });

  test('interrupt ruft query.interrupt() und der abgebrochene Turn endet als turn-aborted OHNE Fehler-Event', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();

    h.session.interrupt('t-1');
    await tick();
    expect(h.queries[0]!.interruptCalls).toBe(1);

    // Das SDK beendet den unterbrochenen Turn mit einem error-result.
    h.queries[0]!.push({ type: 'result', subtype: 'error_during_execution', session_id: 's-1' });
    await tick();

    expect(eventsFor(h.emitted, 't-1')).toEqual([{ type: 'turn-aborted' }]);
  });

  test('nach einem Interrupt läuft der nächste Turn über dieselbe Query (Session lebt weiter)', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();
    h.session.interrupt('t-1');
    h.queries[0]!.push({ type: 'result', subtype: 'error_during_execution', session_id: 's-1' });
    await tick();

    h.session.startTurn({ ...START, turnId: 't-2', prompt: 'stattdessen das' });
    await tick();

    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]!.promptMessages).toHaveLength(2);
  });

  test('Modellwechsel: neue Query OHNE resume (Resume über Modellgrenzen hängt)', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();
    h.queries[0]!.push({ type: 'result', subtype: 'success', session_id: 'sess-1' });
    await tick();

    h.session.startTurn({
      turnId: 't-2',
      prompt: 'weiter',
      resumeSessionId: 'sess-1',
      model: 'claude-opus-4-8',
    });
    await tick();

    expect(h.queries).toHaveLength(2);
    expect(h.queryParams[1]).toMatchObject({ model: 'claude-opus-4-8', resumeSessionId: null });
  });

  test('stirbt die Query mitten im Turn, gibt es error + turn-aborted und der nächste Turn baut neu auf', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();
    h.queries[0]!.fail(new Error('SDK explodiert'));
    await tick();

    const events = eventsFor(h.emitted, 't-1');
    expect(events[0]?.type).toBe('error');
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });

    h.session.startTurn({ ...START, turnId: 't-2', resumeSessionId: 'sess-1' });
    await tick();
    expect(h.queries).toHaveLength(2);
    expect(h.queryParams[1]).toMatchObject({ resumeSessionId: 'sess-1' });
  });

  test('endet die Query still mitten im Turn, wird das ebenfalls als Abbruch gemeldet', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();
    h.queries[0]!.end();
    await tick();

    const events = eventsFor(h.emitted, 't-1');
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
  });

  test('startTurn während eines laufenden Turns wird abgewiesen (Host serialisiert eigentlich)', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();

    h.session.startTurn({ ...START, turnId: 't-2' });
    await tick();

    // Die Ablehnung wird als EIGENE Nachricht gemeldet, nicht nur als Fehlertext
    // im Event-Strom: nur so kann der Host maschinell darauf reagieren und den
    // verklemmten Daemon neu starten lassen.
    expect(h.emitted).toContainEqual({ kind: 'turn-rejected', turnId: 't-2' });
    const events = eventsFor(h.emitted, 't-2');
    // Kein error-Event mehr: die Ablehnung ist ein behandelbarer Zustand, keine
    // Fehlermeldung fuer den Nutzer. Was er zu sehen bekommt, entscheidet der
    // Host, nachdem der Heilungsversuch gelaufen ist.
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: 'turn-aborted' });
    // Der laufende Turn ist davon unberührt.
    h.queries[0]!.push({ type: 'result', subtype: 'success', session_id: 's-1' });
    await tick();
    expect(eventsFor(h.emitted, 't-1').at(-1)).toEqual({
      type: 'turn-completed',
      sessionId: 's-1',
    });
  });

  test('interrupt für einen fremden/beendeten Turn ist ein No-Op', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();

    h.session.interrupt('t-anders');
    await tick();
    expect(h.queries[0]!.interruptCalls).toBe(0);
  });
});

/**
 * Reisst die WebSocket zum Host mitten im Turn ab (msb-NAT verschluckt
 * FIN/RST), synthetisiert der Host `turn-aborted` und beendet den Turn. Der
 * Daemon erfuhr davon NICHTS: seine SDK-Query lief weiter, currentTurnId blieb
 * gesetzt. Beim naechsten start-turn griff die Notwehr-Sperre und wies jeden
 * Folge-Turn ab — „Turn abgewiesen — es laeuft bereits ein Turn." Der Nutzer
 * kam nicht mehr weiter, bis die verwaiste Query zufaellig von selbst endete.
 */
describe('Verbindungsabbruch mitten im Turn', () => {
  test('abandonTurn gibt den Turn frei und laesst den naechsten wieder zu', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();

    // Host weg — der Daemon merkt das nur ueber den close-Handler.
    h.session.abandonTurn();
    await tick();

    h.session.startTurn({ ...START, turnId: 't-2' });
    await tick();

    const zweiter = eventsFor(h.emitted, 't-2');
    expect(zweiter.find((e) => e.type === 'error')).toBeUndefined();
    expect(zweiter.find((e) => e.type === 'turn-aborted')).toBeUndefined();
  });

  test('bricht die laufende SDK-Arbeit ab, statt sie weiterlaufen zu lassen', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();

    h.session.abandonTurn();
    await tick();

    // Ohne interrupt generierte das SDK weiter — Tokens fuer eine Antwort, die
    // niemand mehr entgegennimmt, und der naechste Prompt liefe hinein.
    expect(h.queries[0]?.interruptCalls).toBe(1);
  });

  test('ist folgenlos, wenn gerade kein Turn laeuft', () => {
    const h = makeHarness();
    expect(() => h.session.abandonTurn()).not.toThrow();
    expect(h.queries.length).toBe(0);
  });

  test('die SDK-Query bleibt am Leben — der naechste Turn resumt nahtlos', async () => {
    const h = makeHarness();
    h.session.startTurn(START);
    await tick();
    h.session.abandonTurn();
    await tick();

    h.session.startTurn({ ...START, turnId: 't-2' });
    await tick();

    // KEINE zweite Query: der Abbruch betrifft den Turn, nicht die Sitzung.
    expect(h.queries.length).toBe(1);
  });
});

/**
 * `resumeSessionId: null` heisst laut protocol.ts „frischer Start (die
 * Recovery-Politik liegt beim Host)". chatService verlaesst sich darauf: nach
 * einem Haenger startet der zweite Versuch bewusst OHNE Resume und stellt dem
 * Prompt die Historie voran, um eine korrupte Sitzung zu heilen.
 *
 * Der Daemon verwarf `this.live` aber NUR bei einem Modellwechsel. Bei gleichem
 * Modell landete der Heilungsversuch in genau der haengenden Query, die er
 * heilen sollte — der Nutzer sah bei jedem Versuch dasselbe Timeout.
 */
describe('resumeSessionId: null verlangt einen frischen Start', () => {
  test('verwirft eine Query, die bereits eine Sitzung hat', async () => {
    const h = makeHarness();
    h.session.startTurn({ ...START, resumeSessionId: 'sess-a' });
    await tick();
    // Sitzung etabliert (das SDK meldet sie ueber ein system/init-Message).
    h.queries[0]?.push({ type: 'system', subtype: 'init', session_id: 'sess-a' });
    await tick();
    h.queries[0]?.push({ type: 'result', subtype: 'success', session_id: 'sess-a' });
    await tick();

    h.session.startTurn({ ...START, turnId: 't-2', resumeSessionId: null });
    await tick();

    // Zweite Query, bewusst ohne Resume.
    expect(h.queries.length).toBe(2);
    expect(h.queryParams[1]?.resumeSessionId).toBeNull();
    // Die alte, moeglicherweise haengende Query MUSS interruptet werden — nur
    // input.end() zu rufen laesst sie weitergenerieren, und zwei Agenten
    // schrieben dann gleichzeitig in denselben Workspace.
    expect(h.queries[0]?.interruptCalls).toBe(1);
  });

  test('haelt an der Query fest, solange sie noch keine Sitzung hat', async () => {
    // Sonst risse jeder Turn vor der ersten Sitzungsmeldung die Query ab und
    // der langlebige Streaming-Input waere wertlos.
    const h = makeHarness();
    h.session.startTurn({ ...START, resumeSessionId: null });
    await tick();
    h.queries[0]?.push({ type: 'result', subtype: 'success', session_id: null });
    await tick();

    h.session.startTurn({ ...START, turnId: 't-2', resumeSessionId: null });
    await tick();

    expect(h.queries.length).toBe(1);
  });

  test('ein nicht-null resumeSessionId laesst die laufende Query unberuehrt', async () => {
    const h = makeHarness();
    h.session.startTurn({ ...START, resumeSessionId: 'sess-a' });
    await tick();
    h.queries[0]?.push({ type: 'system', subtype: 'init', session_id: 'sess-a' });
    await tick();
    h.queries[0]?.push({ type: 'result', subtype: 'success', session_id: 'sess-a' });
    await tick();

    h.session.startTurn({ ...START, turnId: 't-2', resumeSessionId: 'sess-a' });
    await tick();

    expect(h.queries.length).toBe(1);
  });
});
