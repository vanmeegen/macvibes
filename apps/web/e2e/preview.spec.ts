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

  // Neu: die iframe-URL zeigt aufs Preview-Gateway (fester Port) mit /p/<id>/,
  // nicht mehr direkt auf den dynamischen VM-Port.
  const src = await iframe.getAttribute('src');
  expect(src).toMatch(/^http:\/\/localhost:\d+\/p\/[^/]+\/$/);

  // Der Dev-Server antwortet wirklich — über das Gateway durchgereicht
  // (Template-agnostisch: nur Status zählt). 127.0.0.1 statt localhost: der
  // Dev-Server bindet IPv4, node-fetch würde localhost sonst zu ::1 auflösen.
  const response = await request.get((src ?? '').replace('localhost', '127.0.0.1'));
  expect(response.ok()).toBeTruthy();

  // Und die Seite RENDERT im iframe: erst damit laufen die root-absoluten
  // Asset-Requests (/@vite/client, /_bun/…) über die Referer-Routing-Logik
  // des Gateways — genau die Bug-Klasse „Preview bleibt schwarz".
  await expect(
    page.frameLocator('[data-testselector="chat-preview"]').locator('body'),
  ).toContainText(/Deine App/i, { timeout: 60_000 });
});

test('Fremdes Projekt: Öffnen startet die Sandbox, Preview wird sichtbar (R10)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);

  await registerNewUser(page);
  const name = uniqueProjectName('Preview Fremd');
  await projectsPage.createProject(name, 'pwa');
  await projectsPage.goto(); // Anlegen führt in den Chat — zurück zur Liste zum Abmelden.
  await projectsPage.logout();

  // Grace-Period (E2E: 1,5 s) abwarten, damit die Sandbox des Owners sicher
  // gestoppt ist — der Besucher muss sie selbst hochfahren.
  await page.waitForTimeout(3_000);

  // Nur-Lese-Besucher: Chat bleibt gesperrt, aber die Sandbox bootet,
  // damit die Live-Preview betrachtet werden kann (R10).
  await registerNewUser(page);
  await projectsPage.filterAll.click();
  await projectsPage.openProject(name);

  await expect(chatPage.readonlyHint).toBeVisible();
  await expect(page.getByTestId('chat-preview')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('chat-preview-unavailable')).toHaveCount(0);
});
