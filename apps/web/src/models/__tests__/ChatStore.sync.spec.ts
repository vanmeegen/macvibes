import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../api/types';
import { ChatStore } from '../ChatStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

import { gqlRequest } from '../../api/graphqlClient';

const gqlRequestMock = vi.mocked(gqlRequest);

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  projectId = 'p1',
): ChatMessage {
  return { id, projectId, turnId: 't1', role, content, createdAt: '2026-11-25T12:00:00.000Z' };
}

/** EventSource-Ersatz mit auslösbaren Ereignissen und steuerbarem readyState. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  readyState = 0;
  onerror: ((err: unknown) => void) | null = null;
  private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  feuere(name: string, data = ''): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ data });
  }

  next(msg: ChatMessage, turnActive: boolean): void {
    this.feuere('next', JSON.stringify({ data: { chatEvents: { message: msg, turnActive } } }));
  }

  static offene(): FakeEventSource[] {
    return FakeEventSource.instances.filter((es) => !es.closed);
  }
}

/** Antworten je Abfrage — die Reihenfolge der Aufrufe ist im neuen Ablauf nicht mehr fest. */
interface Server {
  verlauf: () => Promise<{ chatMessages: ChatMessage[]; turnActive: boolean }>;
  turnActive: () => Promise<{ turnActive: boolean }>;
  send: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  verlaufAufrufe: number;
}

function server(start: Partial<Omit<Server, 'verlaufAufrufe'>> = {}): Server {
  const s: Server = {
    verlauf: async () => ({ chatMessages: [], turnActive: false }),
    turnActive: async () => ({ turnActive: false }),
    send: async () => ({ sendMessage: true }),
    stop: async () => ({ stopTurn: true }),
    verlaufAufrufe: 0,
    ...start,
  };
  gqlRequestMock.mockImplementation((query: string) => {
    if (query.includes('chatMessages')) {
      s.verlaufAufrufe += 1;
      return s.verlauf() as Promise<never>;
    }
    if (query.includes('sendMessage')) return s.send() as Promise<never>;
    if (query.includes('stopTurn')) return s.stop() as Promise<never>;
    return s.turnActive() as Promise<never>;
  });
  return s;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve: (v: T) => void = () => {};
  let reject: (e: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  gqlRequestMock.mockReset();
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * B1 (Härtung 2026-11): Der Abgleich löschte die Arbeits-Anzeige, während der
 * Server die Nachricht noch gar nicht eingereiht hatte (er wartet erst auf die
 * Sandbox), korrigierte nur nach unten und wandte späte Antworten auf das
 * inzwischen geöffnete andere Projekt an.
 */
describe('Abgleich des Turn-Status', () => {
  it('löscht „Agent arbeitet" nicht, solange das eigene Senden noch unterwegs ist', async () => {
    const haengt = deferred<unknown>();
    const s = server({
      send: () => haengt.promise,
      turnActive: async () => ({ turnActive: false }),
    });
    const store = new ChatStore();
    await store.connect('p1');
    store.setDraft('hallo');
    const senden = store.send();
    expect(store.turnActive).toBe(true);

    await store.reconcileTurnActive();
    expect(store.turnActive).toBe(true);

    haengt.resolve({ sendMessage: true });
    await senden;
    void s;
  });

  it('auch nach dem Roundtrip nicht, solange die eigene Zeile unbestätigt ist', async () => {
    server({ turnActive: async () => ({ turnActive: false }) });
    const store = new ChatStore();
    await store.connect('p1');
    store.setDraft('hallo');
    await store.send();
    // Das User-Ereignis vom Server steht noch aus (VM bootet).
    await store.reconcileTurnActive();
    expect(store.turnActive).toBe(true);
  });

  it('übernimmt einen Turn, den der Server ohne Ereignis begonnen hat', async () => {
    // Wiederaufnahme nach einem Server-Neustart: kein Ereignis, aber ein Turn.
    server({ turnActive: async () => ({ turnActive: true }) });
    const store = new ChatStore();
    await store.connect('p1');
    expect(store.turnActive).toBe(false);
    await store.reconcileTurnActive();
    expect(store.turnActive).toBe(true);
  });

  it('eine späte Antwort für Projekt A verändert Projekt B nicht', async () => {
    const antwortA = deferred<{ turnActive: boolean }>();
    const s = server({ turnActive: () => antwortA.promise });
    const store = new ChatStore();
    await store.connect('p1');
    store.turnActive = true;
    const abgleichA = store.reconcileTurnActive();

    s.verlauf = async () => ({ chatMessages: [], turnActive: true });
    await store.connect('p2');
    expect(store.turnActive).toBe(true);

    antwortA.resolve({ turnActive: false });
    await abgleichA;
    expect(store.turnActive).toBe(true);
  });

  it('ein Ereignis während der Abfrage ist neuer als die Antwort', async () => {
    const antwort = deferred<{ turnActive: boolean }>();
    server({ turnActive: () => antwort.promise });
    const store = new ChatStore();
    await store.connect('p1');
    const abgleich = store.reconcileTurnActive();
    FakeEventSource.offene()[0]?.next(message('m1', 'assistant', 'läuft'), true);
    antwort.resolve({ turnActive: false });
    await abgleich;
    expect(store.turnActive).toBe(true);
  });

  it('ein verpasstes Turn-Ende lädt den Verlauf nach (dort fehlen dann meist auch Zeilen)', async () => {
    const s = server({ verlauf: async () => ({ chatMessages: [], turnActive: true }) });
    const store = new ChatStore();
    await store.connect('p1');
    await tick();
    s.verlauf = async () => ({
      chatMessages: [message('m9', 'assistant', 'verpasste Antwort')],
      turnActive: false,
    });
    s.turnActive = async () => ({ turnActive: false });
    await store.reconcileTurnActive();
    expect(store.turnActive).toBe(false);
    expect(store.messages.map((m) => m.content)).toEqual(['verpasste Antwort']);
  });
});

/**
 * B2: Der Server liefert nur künftige Ereignisse. Was zwischen der ersten
 * Verlaufsabfrage und dem Abo oder während eines Abrisses geschrieben wurde,
 * fehlte bis zum Reload; eine einmal gescheiterte Verlaufsabfrage ließ den
 * Chat ohne Verbindung zurück.
 */
describe('Verbindungszyklus', () => {
  it('lädt den Verlauf bei jedem (Wieder-)Verbinden nach und behält eigene Zeilen', async () => {
    const s = server({
      verlauf: async () => ({ chatMessages: [message('m1', 'user', 'frage')], turnActive: true }),
    });
    const store = new ChatStore();
    await store.connect('p1');
    const es = FakeEventSource.offene()[0] as FakeEventSource;
    const vorher = s.verlaufAufrufe;

    // Abriss: währenddessen schreibt der Server Zeilen, die nie als Ereignis ankommen.
    s.verlauf = async () => ({
      chatMessages: [
        message('m1', 'user', 'frage'),
        message('m2', 'tool', 'Bash'),
        message('m3', 'assistant', 'antwort'),
      ],
      turnActive: false,
    });
    es.onerror?.(new Event('error'));
    es.feuere('open');
    await tick();

    expect(s.verlaufAufrufe).toBe(vorher + 1);
    expect(store.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(store.turnActive).toBe(false);
  });

  it('eine während der Abfrage per Ereignis geschriebene Zeile wird nicht vom älteren Stand überschrieben', async () => {
    const s = server({
      verlauf: async () => ({
        chatMessages: [message('m1', 'assistant', 'alt')],
        turnActive: true,
      }),
    });
    const store = new ChatStore();
    await store.connect('p1');
    await tick();
    const es = FakeEventSource.offene()[0] as FakeEventSource;
    const antwort = deferred<{ chatMessages: ChatMessage[]; turnActive: boolean }>();
    s.verlauf = () => antwort.promise;
    es.feuere('open');
    // Während die Abfrage läuft, kommt die neuere Fassung der Zeile als Ereignis.
    es.next(message('m1', 'assistant', 'alt und neu'), true);
    antwort.resolve({ chatMessages: [message('m1', 'assistant', 'alt')], turnActive: true });
    await tick();
    expect(store.messages[0]?.content).toBe('alt und neu');
  });

  it('am Turn-Ende wird der Verlauf nachgeladen', async () => {
    const s = server({ verlauf: async () => ({ chatMessages: [], turnActive: false }) });
    const store = new ChatStore();
    await store.connect('p1');
    await tick();
    const es = FakeEventSource.offene()[0] as FakeEventSource;
    es.next(message('m1', 'user', 'frage'), true);
    const vorher = s.verlaufAufrufe;
    s.verlauf = async () => ({
      chatMessages: [
        message('m1', 'user', 'frage'),
        message('m2', 'tool', 'verpasst'),
        message('m3', 'assistant', 'fertig'),
      ],
      turnActive: false,
    });
    es.next(message('m3', 'assistant', 'fertig'), false);
    await tick();
    expect(s.verlaufAufrufe).toBe(vorher + 1);
    expect(store.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('scheitert die erste Verlaufsabfrage, steht die Verbindung trotzdem und es wird erneut versucht', async () => {
    vi.useFakeTimers();
    let scheitert = true;
    const s = server({
      verlauf: async () => {
        if (scheitert) throw new Error('500');
        return { chatMessages: [message('m1', 'assistant', 'da')], turnActive: false };
      },
    });
    const store = new ChatStore();
    await store.connect('p1');

    expect(store.error).not.toBeNull();
    // Ohne Verbindung kämen keine Ereignisse an und der Tab wäre kein Betrachter.
    expect(FakeEventSource.offene()).toHaveLength(1);

    scheitert = false;
    await vi.advanceTimersByTimeAsync(1100);
    expect(store.messages.map((m) => m.id)).toEqual(['m1']);
    expect(store.error).toBeNull();
    expect(FakeEventSource.offene()).toHaveLength(1);
    void s;
  });

  it('eine endgültig geschlossene Verbindung wird neu aufgebaut', async () => {
    vi.useFakeTimers();
    server();
    const store = new ChatStore();
    await store.connect('p1');
    const erste = FakeEventSource.offene()[0] as FakeEventSource;
    // Proxy antwortet mit 502: der Browser gibt endgültig auf.
    erste.readyState = 2;
    erste.onerror?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(1100);
    const offen = FakeEventSource.instances.filter((es) => es !== erste && !es.closed);
    expect(offen).toHaveLength(1);
  });

  it('bei einem gewöhnlichen Abriss verbindet der Browser selbst neu — keine zweite Verbindung', async () => {
    vi.useFakeTimers();
    server();
    const store = new ChatStore();
    await store.connect('p1');
    const erste = FakeEventSource.offene()[0] as FakeEventSource;
    erste.readyState = 0;
    erste.onerror?.(new Event('error'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('disconnect räumt geplante Neuverbindungen und Verlaufsversuche ab', async () => {
    vi.useFakeTimers();
    server({
      verlauf: async () => {
        throw new Error('500');
      },
    });
    const store = new ChatStore();
    await store.connect('p1');
    const erste = FakeEventSource.offene()[0] as FakeEventSource;
    erste.readyState = 2;
    erste.onerror?.(new Event('error'));
    store.disconnect();
    const aufrufe = gqlRequestMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.instances.filter((es) => !es.closed)).toHaveLength(0);
    expect(gqlRequestMock.mock.calls.length).toBe(aufrufe);
  });
});

/** B1/B11: Fehlerfolgen von send/stop gehören zu dem Projekt, in dem sie entstanden. */
describe('späte Fehler nach einem Projektwechsel', () => {
  it('ein in A gescheitertes Senden verändert B nicht — der Text bleibt als Entwurf bei A', async () => {
    const sendA = deferred<unknown>();
    const s = server({ send: () => sendA.promise });
    const store = new ChatStore();
    await store.connect('p1');
    store.setDraft('für A');
    const senden = store.send();

    s.verlauf = async () => ({ chatMessages: [], turnActive: true });
    await store.connect('p2');
    store.setDraft('tippe in B');

    sendA.reject(new Error('Kapazität'));
    await senden;

    expect(store.error).toBeNull();
    expect(store.draft).toBe('tippe in B');
    expect(store.turnActive).toBe(true);
    await store.connect('p1');
    expect(store.draft).toBe('für A');
  });

  it('scheitert eine zweite Nachricht, während ein Turn läuft, bleibt der Turn als aktiv angezeigt', async () => {
    const s = server();
    const store = new ChatStore();
    await store.connect('p1');
    FakeEventSource.offene()[0]?.next(message('m1', 'user', 'erste'), true);
    s.send = async () => {
      throw new Error('Netz');
    };
    store.setDraft('zweite');
    await store.send();
    expect(store.error).not.toBeNull();
    expect(store.turnActive).toBe(true);
  });

  it('ein in A gescheiterter Stopp meldet seinen Fehler nicht in B', async () => {
    const stopA = deferred<unknown>();
    server({ stop: () => stopA.promise });
    const store = new ChatStore();
    await store.connect('p1');
    const stoppen = store.stop();
    await store.connect('p2');
    stopA.reject(new Error('weg'));
    await stoppen;
    expect(store.error).toBeNull();
  });
});

describe('Entwurf und Aufräumen', () => {
  it('der Entwurf bleibt beim Projekt, in dem er getippt wurde', async () => {
    server();
    const store = new ChatStore();
    await store.connect('p1');
    store.setDraft('nur für A');
    await store.connect('p2');
    expect(store.draft).toBe('');
    await store.connect('p1');
    expect(store.draft).toBe('nur für A');
  });

  it('reset leert Turn-Status, Zeilen und Fehler (Projekt bei offenem Tab gelöscht)', async () => {
    server({
      verlauf: async () => ({ chatMessages: [message('m1', 'user', 'x')], turnActive: true }),
    });
    const store = new ChatStore();
    await store.connect('p1');
    expect(store.turnActive).toBe(true);
    store.reset();
    expect(store.turnActive).toBe(false);
    expect(store.messages).toEqual([]);
    expect(store.projectId).toBeNull();
    expect(FakeEventSource.offene()).toHaveLength(0);
  });
});
