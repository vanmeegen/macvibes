import type { Page } from '@playwright/test';
import { createOwnProject, expect, openAsVisitor, test } from './fixtures';

// R6-Shell (Phase A) & R10 — Read-only für fremde Projekte

test('eigenes Projekt öffnet die Chat-Page mit Eingabebereich', async ({ page, chatPage }) => {
  await createOwnProject(page, 'Chat Projekt');

  await expect(chatPage.backButton).toBeVisible();
  await expect(chatPage.chatInput).toBeVisible();
  await expect(chatPage.readonlyHint).not.toBeVisible();
});

test('fremdes Projekt ist read-only (Hinweis statt Eingabefeld)', async ({ page, chatPage }) => {
  const name = await createOwnProject(page, 'Fremder Chat');
  await openAsVisitor(page, name);

  await expect(chatPage.readonlyHint).toBeVisible();
  await expect(chatPage.chatInput).toHaveCount(0);
});

// R6 — Chat mit Agent (E2E läuft mit MACVIBES_AGENT=fake)

test('Nachricht senden: Antwort streamt in den Verlauf und übersteht einen Reload', async ({
  page,
  chatPage,
}) => {
  await createOwnProject(page, 'Echo Chat');

  await chatPage.send('Hallo Sandbox');
  await expect(chatPage.messagesByRole('user').last()).toContainText('Hallo Sandbox');
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Echo: Hallo Sandbox', {
    timeout: 15_000,
  });

  // Persistenz (R6): Historie kommt nach Reload aus der DB zurück.
  await page.reload();
  await expect(chatPage.messagesByRole('user').last()).toContainText('Hallo Sandbox');
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Echo: Hallo Sandbox');
});

test('Stop-Button bricht einen laufenden Turn ab', async ({ page, chatPage }) => {
  await createOwnProject(page, 'Stopp Test');

  await chatPage.send('Bitte LANGSAM arbeiten');
  await expect(chatPage.stopButton).toBeVisible({ timeout: 15_000 });
  await chatPage.stopButton.click();

  await expect(chatPage.messagesByRole('system').last()).toBeVisible({ timeout: 15_000 });
  await expect(chatPage.stopButton).not.toBeVisible();

  // Nach dem Stop geht es WEITER: der nächste Turn läuft normal, der bisherige
  // Verlauf bleibt erhalten (Live-Befund: „Stop → weiterchatten" war ungeprüft).
  await chatPage.send('Nach dem Stopp weiter');
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Nach dem Stopp weiter', {
    timeout: 15_000,
  });
  await expect(chatPage.messagesByRole('user').first()).toContainText('LANGSAM');
});

test('Nachricht während eines Turns wird EINGEREIHT (kein Abbruch) und danach beantwortet', async ({
  page,
  chatPage,
}) => {
  // Neues Verhalten: ein schnelles „weiter" killt den laufenden Turn NICHT mehr
  // (bei langsamen lokalen Modellen brach das den Turn vor dem ersten Tool-Call
  // ab). Die neue Nachricht läuft als NÄCHSTER Turn; expliziter Abbruch bleibt
  // dem Stop-Button vorbehalten (Opt-in: VITE_MACVIBES_STEER_ON_SEND=true).
  await createOwnProject(page, 'Steering');

  await chatPage.send('LANGSAM alte Aufgabe');
  await expect(chatPage.stopButton).toBeVisible({ timeout: 15_000 });
  // Mitten im laufenden Turn eine weitere Nachricht schicken — sie wird eingereiht.
  await chatPage.send('Neue Aufgabe');

  // Der ERSTE Turn läuft zu Ende (kein „Turn abgebrochen"-Systemeintrag) …
  await expect(chatPage.messagesByRole('assistant').first()).toContainText('LANGSAM alte Aufgabe', {
    timeout: 30_000,
  });
  // … und die zweite Nachricht wird als eigener Turn beantwortet.
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Neue Aufgabe', {
    timeout: 30_000,
  });
  await expect(chatPage.messagesByRole('system')).toHaveCount(0);
});

test('Nur-Lese-Besucher sieht den Chat-Verlauf', async ({ page, chatPage }) => {
  const name = await createOwnProject(page, 'Zuschauer Chat');
  await chatPage.send('Hallo Publikum');
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Echo: Hallo Publikum', {
    timeout: 15_000,
  });
  await openAsVisitor(page, name);

  await expect(chatPage.readonlyHint).toBeVisible();
  await expect(chatPage.messagesByRole('user').last()).toContainText('Hallo Publikum');
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Echo: Hallo Publikum');
});

// Modellwahl pro Chat (Dropdown in der Toolbar)

test('Modellwahl: Default ist Sonnet 5.5, Wechsel persistiert über Reload', async ({
  page,
  chatPage,
}) => {
  await createOwnProject(page, 'Modellwahl');

  // Neue Chats starten mit Claude Sonnet 5.5.
  await expect(chatPage.modelSelect).toContainText('Claude Sonnet 5.5');

  // Umschalten auf das lokale Qwen-Modell …
  await chatPage.selectModel('Qwen3.8-27B-oQ4e-mtp');
  await expect(chatPage.modelSelect).toContainText('Qwen 3.8 27B (lokal, oMLX)');

  // … und die Wahl ist persistent (DB, nicht nur UI-State).
  await page.reload();
  await expect(chatPage.modelSelect).toContainText('Qwen 3.8 27B (lokal, oMLX)');

  // Zurück auf ein Claude-Modell.
  await chatPage.selectModel('claude-haiku-5-5');
  await expect(chatPage.modelSelect).toContainText('Claude Haiku 5.5');
});

// Diktat: Mikro-Button mit lokaler Browser-Erkennung (Chrome On-Device).
// Die Web-Speech-API wird deterministisch gefakt — echte Erkennung braucht
// Chrome-Sprachpakete und ein Mikrofon, beides gibt es im CI nicht.

/** Fake-SpeechRecognition VOR dem App-Load injizieren. */
async function installFakeSpeechRecognition(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      static available(): Promise<string> {
        return Promise.resolve('available');
      }
      static install(): Promise<boolean> {
        return Promise.resolve(true);
      }
      lang = '';
      continuous = false;
      interimResults = false;
      processLocally = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      private timer: ReturnType<typeof setTimeout> | null = null;
      start(): void {
        const text = this.lang === 'en-US' ? 'Build a pomodoro app' : 'Baue eine Pomodoro-App';
        this.timer = setTimeout(() => {
          this.onresult?.({
            resultIndex: 0,
            results: [{ isFinal: false, 0: { transcript: text.slice(0, 9) }, length: 1 }],
          });
          this.timer = setTimeout(() => {
            this.onresult?.({
              resultIndex: 0,
              results: [{ isFinal: true, 0: { transcript: text }, length: 1 }],
            });
          }, 80);
        }, 80);
      }
      stop(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        setTimeout(() => this.onend?.(), 10);
      }
      abort(): void {}
    }
    // globalThis === window im Browser — die e2e-tsconfig kennt kein DOM-lib.
    Object.defineProperty(globalThis, 'SpeechRecognition', {
      value: FakeSpeechRecognition,
      configurable: true,
    });
  });
}

test('Diktat: Mikro-Button schreibt erkannten Text ins Eingabefeld', async ({ page, chatPage }) => {
  await installFakeSpeechRecognition(page);
  await createOwnProject(page, 'Diktat');

  await expect(chatPage.micButton).toBeEnabled();
  await chatPage.micButton.click();
  await expect(chatPage.micButton).toHaveAttribute('data-status', 'recording');

  // Das finale Fake-Ergebnis landet im Entwurf; der User schickt selbst ab.
  await expect(chatPage.chatInput).toHaveValue('Baue eine Pomodoro-App');

  // Zweites Tippen stoppt die Aufnahme.
  await chatPage.micButton.click();
  await expect(chatPage.micButton).toHaveAttribute('data-status', 'idle');
});

test('Diktat: DE/EN-Umschalter wechselt die Erkennungssprache', async ({ page, chatPage }) => {
  await installFakeSpeechRecognition(page);
  await createOwnProject(page, 'Diktat Sprache');

  await expect(chatPage.micLang).toContainText('DE');
  await chatPage.micLang.click();
  await expect(chatPage.micLang).toContainText('EN');

  await chatPage.micButton.click();
  await expect(chatPage.chatInput).toHaveValue('Build a pomodoro app');
});

test('Diktat: ohne Browser-Unterstützung ist der Mikro-Button deaktiviert', async ({
  page,
  chatPage,
}) => {
  // Beide Konstruktoren entfernen — simuliert Nicht-Chromium/alte Browser.
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'SpeechRecognition', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'webkitSpeechRecognition', {
      value: undefined,
      configurable: true,
    });
  });
  await createOwnProject(page, 'Diktat Unsupported');

  await expect(chatPage.micButton).toBeVisible();
  await expect(chatPage.micButton).toBeDisabled();
  await expect(chatPage.micLang).toHaveCount(0);
});

test('Modellwahl: fremdes Projekt zeigt KEIN Dropdown (nur Owner)', async ({ page, chatPage }) => {
  const name = await createOwnProject(page, 'Fremdes Modell');
  await openAsVisitor(page, name);

  await expect(chatPage.readonlyHint).toBeVisible();
  await expect(chatPage.modelSelect).toHaveCount(0);
});
