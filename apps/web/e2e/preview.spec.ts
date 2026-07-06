import { expect, test } from '@playwright/test';
import { registerNewUser, uniqueProjectName } from './fixtures';
import { ChatPage } from './pages/chatPage';
import { ProjectsPage } from './pages/projectsPage';

// R7 — Live-Preview: Dev-Server läuft in der Sandbox, iframe zeigt darauf.

test('Preview: Dev-Server der Sandbox wird im iframe erreichbar', async ({ page, request }) => {
  test.setTimeout(180_000);
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const name = uniqueProjectName('Preview Test');

  await projectsPage.createProject(name, 'pwa');

  // Erst „startet…"-Zustand oder direkt ready — nie ein Browser-Fehlerbild.
  const iframe = page.getByTestId('chat-preview');
  await expect(iframe).toBeVisible({ timeout: 120_000 });

  const src = await iframe.getAttribute('src');
  expect(src).toMatch(/^http:\/\/localhost:\d+\/$/);

  // Der Dev-Server antwortet wirklich (Template-agnostisch: nur Status zählt).
  // 127.0.0.1 statt localhost: der Dev-Server bindet IPv4, node-fetch würde
  // localhost sonst zu ::1 auflösen.
  const response = await request.get((src ?? '').replace('localhost', '127.0.0.1'));
  expect(response.ok()).toBeTruthy();
});

test('Preview zeigt klaren Zustand, wenn die Sandbox gestoppt ist', async ({ page }) => {
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);

  await registerNewUser(page);
  const name = uniqueProjectName('Preview Aus');
  await projectsPage.createProject(name, 'pwa');
  await projectsPage.goto(); // Anlegen führt in den Chat — zurück zur Liste zum Abmelden.
  await projectsPage.logout();

  // Nur-Lese-Besucher startet keine Sandbox → Preview klar als nicht verfügbar markiert.
  await registerNewUser(page);
  await projectsPage.filterAll.click();
  await projectsPage.openProject(name);

  await expect(chatPage.readonlyHint).toBeVisible();
  await expect(page.getByTestId('chat-preview-unavailable')).toBeVisible();
  await expect(page.getByTestId('chat-preview')).toHaveCount(0);
});
