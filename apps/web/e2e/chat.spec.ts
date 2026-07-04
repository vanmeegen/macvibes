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
  await projectsPage.openProject(name);

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
  await projectsPage.openProject(name);

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
  await projectsPage.openProject(name);

  await chatPage.send('Bitte LANGSAM arbeiten');
  await expect(chatPage.stopButton).toBeVisible({ timeout: 15_000 });
  await chatPage.stopButton.click();

  await expect(chatPage.messagesByRole('system').last()).toBeVisible({ timeout: 15_000 });
  await expect(chatPage.stopButton).not.toBeVisible();
});

test('Mid-Turn-Steering: neue Nachricht während eines Turns unterbricht ihn', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);
  const name = uniqueProjectName('Steering');

  await projectsPage.createProject(name, 'pwa');
  await projectsPage.openProject(name);

  await chatPage.send('LANGSAM alte Aufgabe');
  await expect(chatPage.stopButton).toBeVisible({ timeout: 15_000 });
  // Mitten im laufenden Turn nachsteuern.
  await chatPage.send('Neue Aufgabe');

  await expect(chatPage.messagesByRole('system').last()).toBeVisible({ timeout: 15_000 });
  await expect(chatPage.messagesByRole('assistant').last()).toContainText('Echo: Neue Aufgabe', {
    timeout: 15_000,
  });
});

test('Nur-Lese-Besucher sieht den Chat-Verlauf', async ({ page }) => {
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);

  await registerNewUser(page);
  const name = uniqueProjectName('Zuschauer Chat');
  await projectsPage.createProject(name, 'pwa');
  await projectsPage.openProject(name);
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
