# Mikro-Button im macvibes-Chat: lokale Spracherkennung im Browser (DE/EN)

## Context

Marco diktiert seine Prompts (Speech-to-Text) und will einen Mikro-Button direkt im
Chat von macvibes. Anforderungen aus der Klärung:

- **Komplett im Browser** (JavaScript), **null Server-Beteiligung** — keine neuen
  Endpunkte, kein Modell-Hosting, keine Server-Prozesse. Chromium-only ist ok.
- Erkennung **Deutsch + Englisch** in guter Qualität.
- **MVP: Chromes eingebaute On-Device-Erkennung** (Web Speech API mit
  `processLocally: true`, Chrome 139+; de-DE ist offiziell unter den ~17 lokalen
  Sprachpaketen). **Architektur so schneiden, dass Whisper (transformers.js/WebGPU)
  später als zweite Engine nachrüstbar ist** (User-Entscheid: „Erst Chrome, Whisper
  als Ausbau").
- Bedienung: **Tippen = Start/Stopp** (Button pulsiert während Aufnahme).
- Ergebnis landet **im Eingabefeld** (an vorhandenen Text angehängt), User schickt
  selbst ab.
- Wichtig kommuniziert: Mikrofonzugriff braucht einen sicheren Kontext **unabhängig
  vom Modell-Ort**. Auf dem Mac (localhost:5173) ok; andere LAN-Geräte brauchen
  einmalig `chrome://flags/#unsafely-treat-insecure-origin-as-secure` →
  `http://192.168.1.77:5173` (kein HTTPS nötig, Chromium-only). Der Button zeigt in
  nicht-sicheren/nicht-unterstützten Kontexten einen erklärenden Tooltip und ist
  deaktiviert.

**Nur `apps/web` wird angefasst. Kein Server-Code, kein GraphQL, keine Templates.**

## Repo-Anker (aus der Erkundung)

- Eingabezeile: `apps/web/src/pages/ChatPage.tsx` ~355–404 — `Stack direction="row"`
  mit TextField (`data-testselector="chat-input"`), Stop- und Send-`IconButton`
  (`chat-stop`, `chat-send`). Mic-Button kommt in diesen Stack. Nur Owner sehen die
  Eingabe (Read-only-User: Alert `chat-readonly-hint`).
- Draft-Logik: `apps/web/src/models/ChatStore.ts` — `draft`, `setDraft()`;
  DI-über-Konstruktor-Muster für Testbarkeit existiert dort bereits (`steerOnSend`).
- Unit-Test-Muster: `apps/web/src/models/__tests__/ChatStore.spec.ts`
  (`vi.stubGlobal`, gemocktes `gqlRequest`).
- E2E: `apps/web/e2e/chat.spec.ts` + Page Object `e2e/pages/chatPage.ts`;
  Selektion nur über `data-testselector` (`getByTestId`).

## Implementierung (TDD: erst rote Tests, dann Code)

### 1. Transcriber-Abstraktion — `apps/web/src/speech/transcriber.ts` (neu)

```ts
export type SpeechLang = 'de-DE' | 'en-US';
export type SpeechAvailability =
  'available' | 'downloadable' | 'unavailable' | 'insecure' | 'unsupported';

export interface TranscriberCallbacks {
  onInterim(text: string): void; // Zwischenstand (live)
  onFinal(text: string): void; // fertiger Satz → an Draft anhängen
  onError(message: string): void;
  onEnd(): void; // Erkennung beendet (auch nach stop())
}
export interface Transcriber {
  start(lang: SpeechLang, cb: TranscriberCallbacks): void;
  stop(): void;
}
```

- `chromeSpeechAvailability(lang): Promise<SpeechAvailability>`:
  `!window.isSecureContext` → `'insecure'`; kein `SpeechRecognition`/
  `webkitSpeechRecognition` oder keine statische `available()`-Methode →
  `'unsupported'`; sonst `SpeechRecognition.available({ langs: [lang],
processLocally: true })` gemappt.
- `installChromeSpeech(lang)`: wrappt `SpeechRecognition.install(...)` (für
  `'downloadable'` — Chrome lädt das Sprachpaket, Promise-basiert).
- `createChromeTranscriber(): Transcriber` — `continuous: true`,
  `interimResults: true`, `processLocally: true`, `lang`; mappt
  `onresult` (interim/final über `results[i].isFinal`), `onerror`, `onend`.
- Ambient-Typen in `apps/web/src/speech/webSpeech.d.ts` (die neuen statischen
  Methoden + `processLocally` fehlen in lib.dom; minimal & strikt typisieren,
  keine `any`).

### 2. Presentation-Model — `apps/web/src/models/SpeechStore.ts` (neu)

MobX-Store (Muster wie ChatStore, `makeAutoObservable`), Konstruktor-DI für
Testbarkeit: `(appendToDraft: (text: string) => void, deps?: { availability?; install?;
createTranscriber?; storage? })`.

- Observables: `status: 'idle' | 'installing' | 'recording'`,
  `availability: SpeechAvailability | 'unknown'`, `lang: SpeechLang`
  (aus `localStorage['macvibes.speechLang']`, Default `de-DE`), `interimText`,
  `error: string | null`.
- Actions: `init()` (Availability prüfen), `toggle()` (idle→ ggf. install → start;
  recording→stop), `setLang()` (persistiert; Wechsel stoppt laufende Aufnahme).
- `onFinal` → `appendToDraft(text)` (Leerzeichen-Handling: an bestehenden Draft
  mit `' '` anfügen, wenn nicht leer); `onError` → Status zurück auf idle +
  Fehlermeldung; `onEnd` → idle.
- Whisper später = zweite `createTranscriber`-Factory hinter derselben
  Schnittstelle + Eintrag im Sprach-Umschalter („Auto (Whisper)") — kein Umbau nötig.

### 3. UI — `apps/web/src/pages/ChatPage.tsx`

In den Eingabe-Stack (nur Owner-Pfad), links vom Send-Button:

- **Mic-`IconButton`** `data-testselector="chat-mic"`, `aria-label` je Zustand:
  - idle: `MicIcon`; recording: rot pulsierend (CSS-Keyframes via `sx`);
    installing: `CircularProgress size={20}`;
  - `availability` `insecure`/`unsupported`/`unavailable`: disabled mit Tooltip
    (Text erklärt Ursache; bei `insecure` inkl. Kurzhinweis auf den Chrome-Flag-Weg
    fürs LAN).
- **Sprach-Badge** daneben (`ButtonBase`/`Chip`, `data-testselector="chat-mic-lang"`,
  Anzeige „DE"/„EN", Klick toggelt, Tooltip „Diktiersprache").
- Während Aufnahme: `interimText` dezent unter dem Eingabefeld
  (`Typography variant="caption"`, `data-testselector="chat-mic-interim"`).
- `SpeechStore` wird im ChatPage-Scope mit `chatStore` verdrahtet
  (`appendToDraft` ruft intern `chatStore.setDraft(...)` — Join-Logik im Store,
  Komponente bleibt logikfrei/observer).

### 4. Tests (vor der Implementierung schreiben)

- **Unit `apps/web/src/models/__tests__/SpeechStore.spec.ts`** (Vitest): Fake-
  Transcriber/Availability per DI; Fälle: toggle startet bei `available`;
  `downloadable` → erst `install`, dann start (Status `installing`→`recording`);
  final-Ergebnis hängt an Draft an (leer/nicht-leer); interim aktualisiert
  `interimText`; Fehler → idle + `error`; `setLang` persistiert und stoppt Aufnahme;
  `insecure`/`unsupported` → toggle ist No-op.
- **E2E `apps/web/e2e/chat.spec.ts`**: Fake-`SpeechRecognition` via
  `page.addInitScript` (deterministische Klasse: nach `start()` ein interim- und
  ein final-Event, statisches `available()` → `'available'`): Klick auf `chat-mic`
  → Aufnahme-Zustand; final-Event → Text steht im `chat-input`; zweiter Klick
  stoppt. Negativtest: InitScript ohne `SpeechRecognition` → Button disabled.
  Page Object `chatPage.ts` um `mic`/`micLang`/`dictate()` erweitern.

### 5. Doku

- `README.md`: kurzer Abschnitt „Diktieren (Mikro-Button)": Chromium 139+,
  lokal auf dem Mac direkt nutzbar; von LAN-Geräten: einmalig
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure` auf
  `http://<mac-ip>:5173` setzen; Sprachpaket lädt Chrome beim ersten Mal.

## Verifikation

1. `bun run ci` (lint + typecheck + Unit) grün.
2. `bun --filter='@macvibes/web' run e2e` grün (inkl. neuer Mic-Tests).
3. Manuell auf dem Mac (Chrome, localhost:5173): DE-Diktat mit englischen
   Fachbegriffen („bun run typecheck ausführen"), EN-Diktat nach Badge-Umschaltung,
   Abbruch/erneutes Starten, Verhalten bei verweigerter Mikro-Berechtigung.
4. Optional LAN-Gerät mit gesetztem Chrome-Flag gegentesten.

## Bewusst NICHT in diesem Schritt

- Whisper/transformers.js-Engine (Ausbaustufe; Schnittstelle ist vorbereitet).
- HTTPS/mkcert-Setup (nicht nötig dank Flag-Weg).
- Server-Änderungen jeglicher Art.
