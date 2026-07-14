import { expect, test } from '@playwright/test';
import { registerNewUser, uniqueProjectName } from './fixtures';
import { ChatPage } from './pages/chatPage';
import { ProjectsPage } from './pages/projectsPage';

// R6-Shell (Phase A) & R10 — Read-only für fremde Projekte

test('eigenes Projekt öffnet die Chat-Page mit Eingabebereich', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);
  const name = uniqueProjectName('Chat Projekt');

  await projectsPage.createProject(name, 'pwa');

  await expect(chatPage.backButton).toBeVisible();
  await expect(chatPage.chatInput).toBeVisible();
  await expect(chatPage.readonlyHint).not.toBeVisible();
});

test('fremdes Projekt ist read-only (Hinweis statt Eingabefeld)', async ({ page }) => {
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);

  await registerNewUser(page);
  const name = uniqueProjectName('Fremder Chat');
  await projectsPage.createProject(name, 'pwa');
  await projectsPage.goto(); // Anlegen führt in den Chat — zurück zur Liste zum Abmelden.
  await projectsPage.logout();

  await registerNewUser(page);
  await projectsPage.filterAll.click();
  await projectsPage.openProject(name);

  await expect(chatPage.readonlyHint).toBeVisible();
  await expect(chatPage.chatInput).toHaveCount(0);
});

// R6 — Chat mit Agent (E2E läuft mit MACVIBES_AGENT=fake)

test('Nachricht senden: Antwort streamt in den Verlauf und übersteht einen Reload', async ({
  page,
}) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);
  const name = uniqueProjectName('Echo Chat');

  await projectsPage.createProject(name, 'pwa');

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

test('Stop-Button bricht einen laufenden Turn ab', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);
  const name = uniqueProjectName('Stopp Test');

  await projectsPage.createProject(name, 'pwa');

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
}) => {
  // Neues Verhalten: ein schnelles „weiter" killt den laufenden Turn NICHT mehr
  // (bei langsamen lokalen Modellen brach das den Turn vor dem ersten Tool-Call
  // ab). Die neue Nachricht läuft als NÄCHSTER Turn; expliziter Abbruch bleibt
  // dem Stop-Button vorbehalten (Opt-in: VITE_MACVIBES_STEER_ON_SEND=true).
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);
  const name = uniqueProjectName('Steering');

  await projectsPage.createProject(name, 'pwa');

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

test('Nur-Lese-Besucher sieht den Chat-Verlauf', async ({ page }) => {
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);

  await registerNewUser(page);
  const name = uniqueProjectName('Zuschauer Chat');
  await projectsPage.createProject(name, 'pwa');
  await chatPage.send('Hallo Publikum');
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Echo: Hallo Publikum', {
    timeout: 15_000,
  });
  await chatPage.backButton.click();
  await projectsPage.logout();

  await registerNewUser(page);
  await projectsPage.filterAll.click();
  await projectsPage.openProject(name);

  await expect(chatPage.readonlyHint).toBeVisible();
  await expect(chatPage.messagesByRole('user').last()).toContainText('Hallo Publikum');
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Echo: Hallo Publikum');
});

// Modellwahl pro Chat (Dropdown in der Toolbar)

test('Modellwahl: Default ist Sonnet 5, Wechsel persistiert über Reload', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);
  const name = uniqueProjectName('Modellwahl');

  await projectsPage.createProject(name, 'pwa');

  // Neue Chats starten mit Claude Sonnet 5.
  await expect(chatPage.modelSelect).toContainText('Claude Sonnet 5');

  // Umschalten auf das lokale Qwen-Modell …
  await chatPage.selectModel('qwen3.6-coder');
  await expect(chatPage.modelSelect).toContainText('Qwen 27B (lokal)');

  // … und die Wahl ist persistent (DB, nicht nur UI-State).
  await page.reload();
  await expect(chatPage.modelSelect).toContainText('Qwen 27B (lokal)');

  // Zurück auf ein Claude-Modell.
  await chatPage.selectModel('claude-haiku-4-5');
  await expect(chatPage.modelSelect).toContainText('Claude Haiku 4.5');
});

test('Modellwahl: fremdes Projekt zeigt KEIN Dropdown (nur Owner)', async ({ page }) => {
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);

  await registerNewUser(page);
  const name = uniqueProjectName('Fremdes Modell');
  await projectsPage.createProject(name, 'pwa');
  await projectsPage.goto();
  await projectsPage.logout();

  await registerNewUser(page);
  await projectsPage.filterAll.click();
  await projectsPage.openProject(name);

  await expect(chatPage.readonlyHint).toBeVisible();
  await expect(chatPage.modelSelect).toHaveCount(0);
});
