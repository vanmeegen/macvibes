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
