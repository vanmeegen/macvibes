import { makeAutoObservable, runInAction } from 'mobx';
import {
  chromeSpeechAvailability,
  chromeSpeechSupport,
  createChromeTranscriber,
  installChromeSpeech,
  type SpeechAvailability,
  type SpeechLang,
  type SpeechSupport,
  type Transcriber,
} from '../speech/transcriber';

export const SPEECH_LANG_STORAGE_KEY = 'macvibes.speechLang';

export type SpeechStatus = 'idle' | 'installing' | 'recording';

/** Minimaler Ausschnitt des ChatStore, den das Diktat braucht (Entwurf). */
export interface DraftTarget {
  draft: string;
  setDraft(value: string): void;
}

/** Test-/Engine-Seams — Default ist die Chrome-On-Device-Erkennung. */
export interface SpeechDeps {
  support?: () => SpeechSupport;
  availability?: (lang: SpeechLang) => Promise<SpeechAvailability>;
  install?: (lang: SpeechLang) => Promise<boolean>;
  createTranscriber?: () => Transcriber;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}

function readStoredLang(storage: Pick<Storage, 'getItem' | 'setItem'>): SpeechLang {
  const stored = storage.getItem(SPEECH_LANG_STORAGE_KEY);
  return stored === 'en-US' ? 'en-US' : 'de-DE';
}

/** Zugriff auf localStorage — im SSR-/Testkontext ggf. nicht vorhanden. */
function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  if (typeof localStorage !== 'undefined') return localStorage;
  return { getItem: () => null, setItem: () => {} };
}

/**
 * Presentation Model des Mikro-Buttons: Verfügbarkeit der lokalen Erkennung,
 * Aufnahme-Status, Diktiersprache (DE/EN, persistiert) und Übergabe der
 * erkannten Texte in den Chat-Entwurf. Läuft komplett im Browser — der
 * macvibes-Server ist am Diktat nicht beteiligt.
 *
 * WICHTIG: `init()` macht nur synchrone, gefahrlose Checks. Die echte
 * `available()`-Probe läuft erst beim ersten Klick — Chrome auf macOS kann
 * bei diesem Aufruf den Renderer crashen (crbug 444393111); das darf nie
 * automatisch beim Seitenaufbau passieren.
 */
export class SpeechStore {
  status: SpeechStatus = 'idle';
  availability: SpeechAvailability | 'unknown' = 'unknown';
  lang: SpeechLang;
  interimText = '';
  error: string | null = null;

  private readonly supportFn: () => SpeechSupport;
  private readonly availabilityFn: (lang: SpeechLang) => Promise<SpeechAvailability>;
  private readonly installFn: (lang: SpeechLang) => Promise<boolean>;
  private readonly createTranscriber: () => Transcriber;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  /** Aktive Erkennung — bewusst nicht observable. */
  private transcriber: Transcriber | null = null;

  constructor(
    private readonly draftTarget: DraftTarget,
    deps: SpeechDeps = {},
  ) {
    this.supportFn = deps.support ?? chromeSpeechSupport;
    this.availabilityFn = deps.availability ?? chromeSpeechAvailability;
    this.installFn = deps.install ?? installChromeSpeech;
    this.createTranscriber = deps.createTranscriber ?? createChromeTranscriber;
    this.storage = deps.storage ?? defaultStorage();
    this.lang = readStoredLang(this.storage);
    // draftTarget bleibt eine REFERENZ (kein deep-observable Klon) — sonst
    // schreibt setDraft in eine MobX-Kopie und der echte Entwurf bleibt leer.
    makeAutoObservable<this, 'transcriber' | 'draftTarget'>(
      this,
      { transcriber: false, draftTarget: false },
      { autoBind: true },
    );
  }

  /** Kann der Button überhaupt etwas starten? (`unknown` = noch ungeprobt) */
  get canRecord(): boolean {
    return (
      this.availability === 'unknown' ||
      this.availability === 'available' ||
      this.availability === 'downloadable'
    );
  }

  /** Grundvoraussetzungen prüfen (beim Mount) — nur synchrone Checks. */
  init(): void {
    const support = this.supportFn();
    this.availability = support === 'unknown' ? 'unknown' : support;
  }

  /**
   * Tippen = Start/Stopp. Beim ersten Start: Verfügbarkeit proben (gecacht)
   * und bei `downloadable` erst das Sprachpaket installieren.
   */
  async toggle(): Promise<void> {
    if (this.status === 'recording') {
      this.transcriber?.stop();
      return;
    }
    if (this.status === 'installing' || !this.canRecord) return;
    this.error = null;

    if (this.availability === 'unknown') {
      const availability = await this.availabilityFn(this.lang);
      runInAction(() => {
        this.availability = availability;
      });
      if (!this.canRecord) return;
    }

    if (this.availability === 'downloadable') {
      this.status = 'installing';
      const installed = await this.installFn(this.lang);
      if (!installed) {
        runInAction(() => {
          this.status = 'idle';
          this.error = 'Sprachpaket konnte nicht installiert werden.';
        });
        return;
      }
      runInAction(() => {
        this.availability = 'available';
      });
    }

    runInAction(() => {
      this.status = 'recording';
      this.interimText = '';
    });
    const transcriber = this.createTranscriber();
    this.transcriber = transcriber;
    transcriber.start(this.lang, {
      onInterim: this.handleInterim,
      onFinal: this.handleFinal,
      onError: this.handleError,
      onEnd: this.handleEnd,
    });
  }

  /** Diktiersprache wechseln (persistiert; stoppt eine laufende Aufnahme). */
  setLang(lang: SpeechLang): void {
    if (lang === this.lang) return;
    if (this.status === 'recording') this.transcriber?.stop();
    this.lang = lang;
    this.storage.setItem(SPEECH_LANG_STORAGE_KEY, lang);
    // Probe zurücksetzen — der nächste Klick prüft die neue Sprache.
    this.init();
  }

  private handleInterim(text: string): void {
    this.interimText = text;
  }

  private handleFinal(text: string): void {
    this.interimText = '';
    if (text.length === 0) return;
    const draft = this.draftTarget.draft;
    this.draftTarget.setDraft(draft.length > 0 ? `${draft} ${text}` : text);
  }

  private handleError(message: string): void {
    this.status = 'idle';
    this.interimText = '';
    this.error = message;
  }

  private handleEnd(): void {
    this.status = 'idle';
    this.interimText = '';
    this.transcriber = null;
  }
}
