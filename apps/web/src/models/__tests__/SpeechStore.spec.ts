import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SpeechAvailability,
  SpeechSupport,
  Transcriber,
  TranscriberCallbacks,
} from '../../speech/transcriber';
import { SPEECH_LANG_STORAGE_KEY, SpeechStore, type DraftTarget } from '../SpeechStore';

/** Kontrollierbarer Transcriber — Events werden von Hand ausgelöst. */
class FakeTranscriber implements Transcriber {
  started: string[] = [];
  stopped = 0;
  callbacks: TranscriberCallbacks | null = null;

  start(lang: string, callbacks: TranscriberCallbacks): void {
    this.started.push(lang);
    this.callbacks = callbacks;
  }

  stop(): void {
    this.stopped++;
    this.callbacks?.onEnd();
  }
}

class FakeStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function draftTarget(initial = ''): DraftTarget {
  return {
    draft: initial,
    setDraft(value: string) {
      this.draft = value;
    },
  };
}

function makeStore(opts?: {
  support?: SpeechSupport;
  availability?: SpeechAvailability;
  draft?: string;
  install?: () => Promise<boolean>;
  storage?: FakeStorage;
}): {
  store: SpeechStore;
  transcriber: FakeTranscriber;
  target: DraftTarget;
  storage: FakeStorage;
} {
  const transcriber = new FakeTranscriber();
  const target = draftTarget(opts?.draft ?? '');
  const storage = opts?.storage ?? new FakeStorage();
  const store = new SpeechStore(target, {
    support: () => opts?.support ?? 'unknown',
    availability: () => Promise.resolve(opts?.availability ?? 'available'),
    install: opts?.install ?? ((): Promise<boolean> => Promise.resolve(true)),
    createTranscriber: () => transcriber,
    storage,
  });
  return { store, transcriber, target, storage };
}

describe('SpeechStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('init (nur synchrone Checks — available() darf hier NIE laufen)', () => {
    it('Support ok → Zustand bleibt unknown, Button nutzbar', () => {
      const { store } = makeStore({ support: 'unknown' });
      store.init();
      expect(store.availability).toBe('unknown');
      expect(store.canRecord).toBe(true);
    });

    it('unsupported → canRecord ist false', () => {
      const { store } = makeStore({ support: 'unsupported' });
      store.init();
      expect(store.availability).toBe('unsupported');
      expect(store.canRecord).toBe(false);
    });

    it('insecure → canRecord ist false', () => {
      const { store } = makeStore({ support: 'insecure' });
      store.init();
      expect(store.availability).toBe('insecure');
      expect(store.canRecord).toBe(false);
    });

    it('init ruft die async-Probe NICHT auf (Chromium-Crash-Bug auf macOS)', () => {
      const availability = vi.fn(() => Promise.resolve<SpeechAvailability>('available'));
      const store = new SpeechStore(draftTarget(), {
        support: () => 'unknown',
        availability,
        install: () => Promise.resolve(true),
        createTranscriber: () => new FakeTranscriber(),
        storage: new FakeStorage(),
      });
      store.init();
      expect(availability).not.toHaveBeenCalled();
    });
  });

  describe('toggle', () => {
    it('erster Klick: prüft die Verfügbarkeit und startet die Aufnahme', async () => {
      const { store, transcriber } = makeStore({ availability: 'available' });
      store.init();
      await store.toggle();
      expect(store.availability).toBe('available');
      expect(store.status).toBe('recording');
      expect(transcriber.started).toEqual(['de-DE']);
    });

    it('Probe unavailable → keine Aufnahme, Button-Zustand aktualisiert', async () => {
      const { store, transcriber } = makeStore({ availability: 'unavailable' });
      store.init();
      await store.toggle();
      expect(store.availability).toBe('unavailable');
      expect(store.status).toBe('idle');
      expect(transcriber.started).toEqual([]);
      expect(store.canRecord).toBe(false);
    });

    it('Probe läuft nur beim ERSTEN Klick (Ergebnis wird gecacht)', async () => {
      const availability = vi.fn(() => Promise.resolve<SpeechAvailability>('available'));
      const transcriber = new FakeTranscriber();
      const store = new SpeechStore(draftTarget(), {
        support: () => 'unknown',
        availability,
        install: () => Promise.resolve(true),
        createTranscriber: () => transcriber,
        storage: new FakeStorage(),
      });
      store.init();
      await store.toggle();
      await store.toggle(); // stoppt
      await store.toggle(); // startet erneut
      expect(availability).toHaveBeenCalledTimes(1);
    });

    it('zweites Tippen stoppt die Aufnahme', async () => {
      const { store, transcriber } = makeStore();
      store.init();
      await store.toggle();
      await store.toggle();
      expect(transcriber.stopped).toBe(1);
      expect(store.status).toBe('idle');
    });

    it('downloadable: installiert erst das Sprachpaket, dann Aufnahme', async () => {
      const install = vi.fn(() => Promise.resolve(true));
      const { store, transcriber } = makeStore({ availability: 'downloadable', install });
      store.init();
      await store.toggle();
      expect(install).toHaveBeenCalledWith('de-DE');
      expect(store.availability).toBe('available');
      expect(store.status).toBe('recording');
      expect(transcriber.started).toEqual(['de-DE']);
    });

    it('fehlgeschlagene Installation → Fehler, keine Aufnahme', async () => {
      const { store, transcriber } = makeStore({
        availability: 'downloadable',
        install: () => Promise.resolve(false),
      });
      store.init();
      await store.toggle();
      expect(store.status).toBe('idle');
      expect(store.error).not.toBeNull();
      expect(transcriber.started).toEqual([]);
    });

    it('unsupported: toggle ist ein No-op', async () => {
      const { store, transcriber } = makeStore({ support: 'unsupported' });
      store.init();
      await store.toggle();
      expect(store.status).toBe('idle');
      expect(transcriber.started).toEqual([]);
    });
  });

  describe('Erkennungs-Ergebnisse', () => {
    it('final-Ergebnis landet im leeren Entwurf', async () => {
      const { store, transcriber, target } = makeStore();
      store.init();
      await store.toggle();
      transcriber.callbacks?.onFinal('Baue eine Todo-App');
      expect(target.draft).toBe('Baue eine Todo-App');
    });

    it('final-Ergebnis wird mit Leerzeichen an bestehenden Text angehängt', async () => {
      const { store, transcriber, target } = makeStore({ draft: 'Bitte' });
      store.init();
      await store.toggle();
      transcriber.callbacks?.onFinal('bun run typecheck ausführen');
      expect(target.draft).toBe('Bitte bun run typecheck ausführen');
    });

    it('interim aktualisiert interimText und wird nach final geleert', async () => {
      const { store, transcriber } = makeStore();
      store.init();
      await store.toggle();
      transcriber.callbacks?.onInterim('Baue eine');
      expect(store.interimText).toBe('Baue eine');
      transcriber.callbacks?.onFinal('Baue eine Todo-App');
      expect(store.interimText).toBe('');
    });

    it('Fehler → idle + Meldung, interim geleert', async () => {
      const { store, transcriber } = makeStore();
      store.init();
      await store.toggle();
      transcriber.callbacks?.onInterim('Hal');
      transcriber.callbacks?.onError('Mikrofon-Zugriff verweigert');
      expect(store.status).toBe('idle');
      expect(store.error).toBe('Mikrofon-Zugriff verweigert');
      expect(store.interimText).toBe('');
    });

    it('onEnd (Erkennung endet von selbst) → zurück auf idle', async () => {
      const { store, transcriber } = makeStore();
      store.init();
      await store.toggle();
      transcriber.callbacks?.onEnd();
      expect(store.status).toBe('idle');
    });
  });

  describe('Sprache', () => {
    it('Default de-DE; gespeicherte Sprache wird geladen', () => {
      const storage = new FakeStorage();
      storage.setItem(SPEECH_LANG_STORAGE_KEY, 'en-US');
      const { store } = makeStore({ storage });
      expect(store.lang).toBe('en-US');
    });

    it('setLang persistiert und stoppt eine laufende Aufnahme', async () => {
      const { store, transcriber, storage } = makeStore();
      store.init();
      await store.toggle();
      store.setLang('en-US');
      expect(store.lang).toBe('en-US');
      expect(storage.getItem(SPEECH_LANG_STORAGE_KEY)).toBe('en-US');
      expect(transcriber.stopped).toBe(1);
      expect(store.status).toBe('idle');
    });

    it('setLang setzt die Probe zurück — nächster Klick prüft die neue Sprache', async () => {
      const availability = vi.fn((lang: string) =>
        Promise.resolve<SpeechAvailability>(lang === 'de-DE' ? 'available' : 'downloadable'),
      );
      const transcriber = new FakeTranscriber();
      const store = new SpeechStore(draftTarget(), {
        support: () => 'unknown',
        availability,
        install: () => Promise.resolve(true),
        createTranscriber: () => transcriber,
        storage: new FakeStorage(),
      });
      store.init();
      await store.toggle(); // Probe de-DE
      store.setLang('en-US');
      expect(store.availability).toBe('unknown');
      await store.toggle(); // Probe en-US → downloadable → install → start
      expect(availability).toHaveBeenLastCalledWith('en-US');
      expect(store.availability).toBe('available');
    });
  });
});
