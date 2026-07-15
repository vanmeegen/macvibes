/**
 * Browser-lokale Spracherkennung (Diktat) — Abstraktion + Chrome-Implementierung.
 *
 * MVP nutzt Chromes On-Device-Erkennung (Web Speech API mit `processLocally`,
 * Chrome 139+): das Sprachpaket läuft komplett lokal, nichts verlässt den
 * Rechner, der Server ist nicht beteiligt. Die `Transcriber`-Schnittstelle ist
 * bewusst engine-neutral, damit später z. B. Whisper (transformers.js/WebGPU)
 * als zweite Implementierung dahinter passt.
 */

export type SpeechLang = 'de-DE' | 'en-US';

/**
 * Verfügbarkeit der lokalen Erkennung im aktuellen Browser-Kontext.
 * - `insecure`: kein Secure Context (Mikrofon gesperrt; localhost zählt als sicher)
 * - `unsupported`: Browser kann keine On-Device-Erkennung (kein Chromium 139+)
 * - `downloadable`: Sprachpaket muss Chrome erst noch herunterladen
 */
export type SpeechAvailability =
  'available' | 'downloadable' | 'unavailable' | 'insecure' | 'unsupported';

export interface TranscriberCallbacks {
  /** Zwischenstand während des Sprechens (live, ersetzt sich fortlaufend). */
  onInterim(text: string): void;
  /** Fertig erkannter Abschnitt — wird an den Entwurf angehängt. */
  onFinal(text: string): void;
  onError(message: string): void;
  /** Erkennung ist beendet (nach stop(), Fehler oder von selbst). */
  onEnd(): void;
}

export interface Transcriber {
  start(lang: SpeechLang, callbacks: TranscriberCallbacks): void;
  stop(): void;
}

/* ------------------------- Chrome Web Speech API ------------------------- */
/* Die On-Device-Statics (available/install) und `processLocally` sind noch
   nicht in lib.dom — lokale Minimal-Typen statt globaler Augmentation. */

interface ChromeRecognitionAlternative {
  readonly transcript: string;
}
interface ChromeRecognitionResult {
  readonly isFinal: boolean;
  readonly 0: ChromeRecognitionAlternative;
  readonly length: number;
}
interface ChromeRecognitionResultList {
  readonly length: number;
  [index: number]: ChromeRecognitionResult;
}
export interface ChromeRecognitionEvent {
  readonly resultIndex: number;
  readonly results: ChromeRecognitionResultList;
}
export interface ChromeRecognitionErrorEvent {
  readonly error: string;
}

export interface ChromeSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  onresult: ((event: ChromeRecognitionEvent) => void) | null;
  onerror: ((event: ChromeRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface ChromeSpeechRecognitionCtor {
  new (): ChromeSpeechRecognition;
  available?(options: {
    langs: string[];
    processLocally: boolean;
  }): Promise<'available' | 'downloadable' | 'downloading' | 'unavailable'>;
  install?(options: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}

/** Chromium exponiert den Konstruktor teils nur mit webkit-Präfix. */
export function speechRecognitionCtor(): ChromeSpeechRecognitionCtor | null {
  const w = globalThis as {
    SpeechRecognition?: ChromeSpeechRecognitionCtor;
    webkitSpeechRecognition?: ChromeSpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Synchron feststellbare Grundvoraussetzungen (gefahrlos beim Seitenaufbau). */
export type SpeechSupport = 'insecure' | 'unsupported' | 'unknown';

/**
 * Nur synchrone Checks — KEIN Aufruf von SpeechRecognition.available()!
 * Chrome auf macOS hat einen Bug (crbug 444393111), bei dem available()
 * den Renderer-Prozess abschießen kann. Die echte Probe passiert deshalb
 * erst nutzergetriggert beim Klick auf den Mikro-Button.
 */
export function chromeSpeechSupport(): SpeechSupport {
  // Ohne Secure Context gibt der Browser das Mikrofon nicht frei — das gilt
  // unabhängig davon, wo das Modell läuft. localhost zählt als sicher; im LAN
  // hilft chrome://flags/#unsafely-treat-insecure-origin-as-secure.
  if (!globalThis.isSecureContext) return 'insecure';
  // Die statische available()-Methode existiert erst mit der On-Device-Fähigkeit
  // (Chrome 139+) — ältere Browser hätten nur die Cloud-Erkennung, die wir hier
  // bewusst NICHT verwenden.
  const ctor = speechRecognitionCtor();
  if (ctor?.available === undefined) return 'unsupported';
  return 'unknown';
}

/** Promise mit Timeout — die On-Device-API hängt auf manchen Systemen fest. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Prüft, ob On-Device-Erkennung für die Sprache nutzbar/installierbar ist. */
export async function chromeSpeechAvailability(lang: SpeechLang): Promise<SpeechAvailability> {
  const support = chromeSpeechSupport();
  if (support !== 'unknown') return support;
  const ctor = speechRecognitionCtor();
  if (ctor?.available === undefined) return 'unsupported';
  try {
    const result = await withTimeout(
      ctor.available({ langs: [lang], processLocally: true }),
      5_000,
      'unavailable' as const,
    );
    if (result === 'available') return 'available';
    if (result === 'downloadable' || result === 'downloading') return 'downloadable';
    return 'unavailable';
  } catch (err) {
    console.error('SpeechRecognition.available() fehlgeschlagen', err);
    return 'unavailable';
  }
}

/** Lädt das lokale Sprachpaket nach (Chrome zeigt den Download selbst an). */
export async function installChromeSpeech(lang: SpeechLang): Promise<boolean> {
  const ctor = speechRecognitionCtor();
  if (ctor?.install === undefined) return false;
  try {
    // Großzügiges Limit für den Paket-Download; bekannte Hänger (Install-Promise
    // resolvt nie, z. B. Brave) laufen so kontrolliert in einen Fehler.
    return await withTimeout(ctor.install({ langs: [lang], processLocally: true }), 180_000, false);
  } catch (err) {
    console.error('SpeechRecognition.install() fehlgeschlagen', err);
    return false;
  }
}

/** Web-Speech-Fehlercodes in verständliche Meldungen übersetzen. */
function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Mikrofon-Zugriff verweigert — bitte in den Browser-Einstellungen erlauben.';
    case 'audio-capture':
      return 'Kein Mikrofon gefunden.';
    case 'language-not-supported':
      return 'Diese Sprache ist lokal nicht verfügbar.';
    case 'no-speech':
      return 'Keine Sprache erkannt.';
    default:
      return `Spracherkennung fehlgeschlagen (${code}).`;
  }
}

/** Transcriber auf Basis von Chromes lokaler Web-Speech-Erkennung. */
export function createChromeTranscriber(): Transcriber {
  let recognition: ChromeSpeechRecognition | null = null;

  return {
    start(lang: SpeechLang, callbacks: TranscriberCallbacks): void {
      const ctor = speechRecognitionCtor();
      if (ctor === null) {
        callbacks.onError('Spracherkennung wird von diesem Browser nicht unterstützt.');
        callbacks.onEnd();
        return;
      }
      const rec = new ctor();
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.processLocally = true;
      rec.onresult = (event) => {
        // Im continuous-Modus enthält results auch alle früheren Abschnitte —
        // relevant ist nur ab resultIndex. Interim-Teile fortlaufend sammeln,
        // finale Abschnitte einzeln melden.
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result === undefined) continue;
          const transcript = result[0].transcript;
          if (result.isFinal) {
            callbacks.onFinal(transcript.trim());
          } else {
            interim += transcript;
          }
        }
        // Leere Interims nicht melden — final-Ergebnisse räumen die Anzeige
        // selbst ab (SpeechStore.handleFinal).
        const interimTrimmed = interim.trim();
        if (interimTrimmed.length > 0) callbacks.onInterim(interimTrimmed);
      };
      rec.onerror = (event) => {
        callbacks.onError(speechErrorMessage(event.error));
      };
      rec.onend = () => {
        recognition = null;
        callbacks.onEnd();
      };
      recognition = rec;
      rec.start();
    },

    stop(): void {
      recognition?.stop();
    },
  };
}
