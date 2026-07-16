import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chromeSpeechAvailability,
  createChromeTranscriber,
  installChromeSpeech,
  type ChromeRecognitionErrorEvent,
  type ChromeRecognitionEvent,
  type TranscriberCallbacks,
} from '../transcriber';

/** Nachbau des Chrome-SpeechRecognition-Objekts inkl. On-Device-Statics. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static availableResult = 'available';
  static installResult = true;
  static availableCalls: unknown[] = [];

  lang = '';
  continuous = false;
  interimResults = false;
  processLocally?: boolean;
  onresult: ((event: ChromeRecognitionEvent) => void) | null = null;
  onerror: ((event: ChromeRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  static available(options: unknown): Promise<string> {
    FakeRecognition.availableCalls.push(options);
    return Promise.resolve(FakeRecognition.availableResult);
  }

  static install(): Promise<boolean> {
    return Promise.resolve(FakeRecognition.installResult);
  }

  start(): void {
    this.startCalls++;
  }

  stop(): void {
    this.stopCalls++;
  }

  abort(): void {
    this.abortCalls++;
  }
}

function resultEvent(
  entries: { transcript: string; isFinal: boolean }[],
  resultIndex = 0,
): ChromeRecognitionEvent {
  const results = entries.map((e) => ({
    isFinal: e.isFinal,
    0: { transcript: e.transcript },
    length: 1,
  }));
  return { resultIndex, results: Object.assign(results, { length: results.length }) };
}

function callbacks(): TranscriberCallbacks & {
  interims: string[];
  finals: string[];
  errors: string[];
  ends: number;
} {
  const record = {
    interims: [] as string[],
    finals: [] as string[],
    errors: [] as string[],
    ends: 0,
    onInterim(text: string) {
      record.interims.push(text);
    },
    onFinal(text: string) {
      record.finals.push(text);
    },
    onError(message: string) {
      record.errors.push(message);
    },
    onEnd() {
      record.ends++;
    },
  };
  return record;
}

function stubRecognition(): void {
  FakeRecognition.instances = [];
  FakeRecognition.availableCalls = [];
  FakeRecognition.availableResult = 'available';
  vi.stubGlobal('SpeechRecognition', FakeRecognition);
  vi.stubGlobal('isSecureContext', true);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chromeSpeechAvailability', () => {
  it('meldet insecure ohne Secure Context', async () => {
    stubRecognition();
    vi.stubGlobal('isSecureContext', false);
    expect(await chromeSpeechAvailability('de-DE')).toBe('insecure');
  });

  it('meldet unsupported ohne SpeechRecognition-Konstruktor', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('SpeechRecognition', undefined);
    vi.stubGlobal('webkitSpeechRecognition', undefined);
    expect(await chromeSpeechAvailability('de-DE')).toBe('unsupported');
  });

  it('meldet unsupported, wenn die On-Device-Statics fehlen (alte Browser)', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('SpeechRecognition', class {});
    expect(await chromeSpeechAvailability('de-DE')).toBe('unsupported');
  });

  it('fragt Chrome mit processLocally, Sprache und Diktat-Qualität an', async () => {
    // quality: 'dictation' ist entscheidend (Live-Befund 2026-07-16): ohne die
    // Angabe meldet Chrome 150 "available", obwohl nur die Command-Stufe
    // existiert — die Erkennung liefert dann nie Ergebnisse (Zombie).
    // Ältere Chromes ignorieren das unbekannte Dictionary-Feld gefahrlos.
    stubRecognition();
    FakeRecognition.availableResult = 'downloadable';
    expect(await chromeSpeechAvailability('de-DE')).toBe('downloadable');
    expect(FakeRecognition.availableCalls[0]).toEqual({
      langs: ['de-DE'],
      processLocally: true,
      quality: 'dictation',
    });
  });

  it('mappt downloading auf downloadable (Download läuft schon)', async () => {
    stubRecognition();
    FakeRecognition.availableResult = 'downloading';
    expect(await chromeSpeechAvailability('de-DE')).toBe('downloadable');
  });
});

describe('installChromeSpeech', () => {
  it('reicht das Install-Ergebnis durch', async () => {
    stubRecognition();
    FakeRecognition.installResult = true;
    expect(await installChromeSpeech('de-DE')).toBe(true);
  });
});

describe('createChromeTranscriber', () => {
  it('konfiguriert die Erkennung lokal, kontinuierlich und mit interim-Ergebnissen', () => {
    stubRecognition();
    const transcriber = createChromeTranscriber();
    transcriber.start('de-DE', callbacks());
    const rec = FakeRecognition.instances[0];
    expect(rec).toBeDefined();
    expect(rec?.lang).toBe('de-DE');
    expect(rec?.continuous).toBe(true);
    expect(rec?.interimResults).toBe(true);
    expect(rec?.processLocally).toBe(true);
    expect(rec?.startCalls).toBe(1);
  });

  it('trennt interim- und final-Ergebnisse', () => {
    stubRecognition();
    const transcriber = createChromeTranscriber();
    const cb = callbacks();
    transcriber.start('de-DE', cb);
    const rec = FakeRecognition.instances[0];
    rec?.onresult?.(resultEvent([{ transcript: 'Baue eine', isFinal: false }]));
    rec?.onresult?.(resultEvent([{ transcript: 'Baue eine Todo-App', isFinal: true }]));
    expect(cb.interims).toEqual(['Baue eine']);
    expect(cb.finals).toEqual(['Baue eine Todo-App']);
  });

  it('verarbeitet nur Ergebnisse ab resultIndex (continuous-Modus)', () => {
    stubRecognition();
    const transcriber = createChromeTranscriber();
    const cb = callbacks();
    transcriber.start('de-DE', cb);
    const rec = FakeRecognition.instances[0];
    rec?.onresult?.(
      resultEvent(
        [
          { transcript: 'Alter Satz.', isFinal: true },
          { transcript: 'Neuer Satz.', isFinal: true },
        ],
        1,
      ),
    );
    expect(cb.finals).toEqual(['Neuer Satz.']);
  });

  it('meldet Fehler lesbar und beendet', () => {
    stubRecognition();
    const transcriber = createChromeTranscriber();
    const cb = callbacks();
    transcriber.start('de-DE', cb);
    const rec = FakeRecognition.instances[0];
    rec?.onerror?.({ error: 'not-allowed' });
    rec?.onend?.();
    expect(cb.errors).toHaveLength(1);
    expect(cb.errors[0]).toMatch(/Mikrofon/);
    expect(cb.ends).toBe(1);
  });

  it('stop() stoppt die laufende Erkennung', () => {
    stubRecognition();
    const transcriber = createChromeTranscriber();
    transcriber.start('de-DE', callbacks());
    transcriber.stop();
    expect(FakeRecognition.instances[0]?.stopCalls).toBe(1);
  });
});

describe('createChromeTranscriber — Watchdogs (Zombie-Erkennung, Live-Befund 2026-07-16)', () => {
  it('bricht ab, wenn nach Sprachbeginn nie ein Ergebnis kommt', () => {
    vi.useFakeTimers();
    stubRecognition();
    const transcriber = createChromeTranscriber({ resultTimeoutMs: 100 });
    const cb = callbacks();
    transcriber.start('de-DE', cb);
    const rec = FakeRecognition.instances[0]!;

    rec.onspeechstart?.();
    vi.advanceTimersByTime(150);

    expect(rec.abortCalls).toBe(1);
    expect(cb.errors).toHaveLength(1);
    expect(cb.errors[0]).toMatch(/keine Ergebnisse/);
    expect(cb.ends).toBe(1);
    vi.useRealTimers();
  });

  it('lässt Sprechpausen zu: nach dem ERSTEN Ergebnis ist der Watchdog entschärft', () => {
    vi.useFakeTimers();
    stubRecognition();
    const transcriber = createChromeTranscriber({ resultTimeoutMs: 100 });
    const cb = callbacks();
    transcriber.start('de-DE', cb);
    const rec = FakeRecognition.instances[0]!;

    rec.onspeechstart?.();
    rec.onresult?.(resultEvent([{ transcript: 'Hallo', isFinal: false }]));
    vi.advanceTimersByTime(500);

    expect(rec.abortCalls).toBe(0);
    expect(cb.errors).toEqual([]);
    expect(cb.ends).toBe(0);
    vi.useRealTimers();
  });

  it('erzwingt das Ende, wenn stop() kein end-Event liefert (Blinken hört IMMER auf)', () => {
    vi.useFakeTimers();
    stubRecognition();
    const transcriber = createChromeTranscriber({ stopTimeoutMs: 100 });
    const cb = callbacks();
    transcriber.start('de-DE', cb);
    const rec = FakeRecognition.instances[0]!;

    transcriber.stop();
    vi.advanceTimersByTime(150);

    expect(rec.abortCalls).toBe(1);
    expect(cb.ends).toBe(1);

    // Kommt das echte end-Event doch noch, darf onEnd nicht doppelt feuern.
    rec.onend?.();
    expect(cb.ends).toBe(1);
    vi.useRealTimers();
  });

  it('normales Ende räumt die Watchdogs ab — kein nachträglicher Abbruch', () => {
    vi.useFakeTimers();
    stubRecognition();
    const transcriber = createChromeTranscriber({ resultTimeoutMs: 100, stopTimeoutMs: 100 });
    const cb = callbacks();
    transcriber.start('de-DE', cb);
    const rec = FakeRecognition.instances[0]!;

    rec.onspeechstart?.();
    transcriber.stop();
    rec.onend?.();
    vi.advanceTimersByTime(500);

    expect(rec.abortCalls).toBe(0);
    expect(cb.ends).toBe(1);
    expect(cb.errors).toEqual([]);
    vi.useRealTimers();
  });
});
