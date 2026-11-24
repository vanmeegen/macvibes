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
import { browserStorage, readSetting, writeSetting, type SettingsStorage } from './safeStorage';

export const SPEECH_LANG_STORAGE_KEY = 'macvibes.speechLang';

type SpeechStatus = 'idle' | 'installing' | 'recording';

/** Minimaler Ausschnitt des ChatStore, den das Diktat braucht (Entwurf). */
export interface DraftTarget {
  draft: string;
  setDraft(value: string): void;
}

/** Test-/Engine-Seams — Default ist die Chrome-On-Device-Erkennung. */
interface SpeechDeps {
  support?: () => SpeechSupport;
  availability?: (lang: SpeechLang) => Promise<SpeechAvailability>;
  install?: (lang: SpeechLang) => Promise<boolean>;
  createTranscriber?: () => Transcriber;
  storage?: SettingsStorage;
}

function readStoredLang(storage: SettingsStorage): SpeechLang {
  return readSetting(storage, SPEECH_LANG_STORAGE_KEY) === 'en-US' ? 'en-US' : 'de-DE';
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
  private readonly storage: SettingsStorage;
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
    this.storage = deps.storage ?? browserStorage();
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

  /**
   * Beschriftung des Mikro-Buttons. Die Verfügbarkeit schlägt den Status: wer
   * gar nicht aufnehmen kann, soll den Grund lesen, nicht „Aufnahme stoppen".
   */
  get tooltip(): string {
    switch (this.availability) {
      case 'insecure':
        return (
          'Diktat braucht einen sicheren Kontext. Auf dem Mac localhost verwenden; ' +
          'im LAN einmalig chrome://flags/#unsafely-treat-insecure-origin-as-secure ' +
          'für diese Adresse aktivieren.'
        );
      case 'unsupported':
        return 'Lokale Spracherkennung braucht Chrome/Chromium 139+.';
      case 'unavailable':
        return 'Für diese Sprache ist keine lokale Erkennung verfügbar.';
      default:
        break;
    }
    if (this.status === 'recording') return 'Aufnahme stoppen';
    if (this.status === 'installing') return 'Sprachpaket wird installiert …';
    return 'Diktieren — läuft komplett lokal im Browser';
  }

  get isRecording(): boolean {
    return this.status === 'recording';
  }

  /** Aria-Label des Mikro-Buttons. */
  get micLabel(): string {
    return this.isRecording ? 'Aufnahme stoppen' : 'Diktieren';
  }

  /** Kürzel der Diktiersprache für den Umschalter. */
  get langLabel(): string {
    return this.lang === 'de-DE' ? 'DE' : 'EN';
  }

  /** Vorläufiger Erkennungstext — nur während der Aufnahme und wenn es einen gibt. */
  get showInterim(): boolean {
    return this.isRecording && this.interimText.length > 0;
  }

  /** Grundvoraussetzungen prüfen (beim Mount) — nur synchrone Checks. */
  init(): void {
    this.availability = this.supportFn();
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
      runInAction(() => {
        this.status = 'installing';
      });
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
    writeSetting(this.storage, SPEECH_LANG_STORAGE_KEY, lang);
    // Probe zurücksetzen — der nächste Klick prüft die neue Sprache.
    this.init();
  }

  /** Wechselt zwischen Deutsch und Englisch. */
  toggleLang(): void {
    this.setLang(this.lang === 'de-DE' ? 'en-US' : 'de-DE');
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
