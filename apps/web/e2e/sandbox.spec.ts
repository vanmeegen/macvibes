import { expect, test } from '@playwright/test';
import { registerNewUser, uniqueProjectName } from './fixtures';
import { ChatPage } from './pages/chatPage';
import { ProjectsPage } from './pages/projectsPage';

// R9 — Sandbox-Lebenszyklus (E2E läuft mit MACVIBES_GRACE_MS=1500)

test('Sandbox startet beim Öffnen der Chat-Page und stoppt nach der Grace-Period', async ({
  page,
}) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);
  const name = uniqueProjectName('Lifecycle');

  await projectsPage.createProject(name, 'pwa');

  // Frisch angelegt: gestoppt.
  const card = projectsPage.cardByName(name);
  await expect(projectsPage.statusChipIn(card)).toHaveAttribute('data-status', 'stopped');

  // Öffnen startet die Sandbox; Startfortschritt bis "running" sichtbar (R6).
  await projectsPage.openProject(name);
  await expect(chatPage.sandboxStatus).toHaveAttribute('data-status', 'running', {
    timeout: 15_000,
  });

  // Zurück zur Übersicht: Sandbox läuft weiter (Grace-Period).
  await chatPage.backButton.click();
  await expect(projectsPage.statusChipIn(projectsPage.cardByName(name))).toHaveAttribute(
    'data-status',
    'running',
  );

  // Nach Ablauf der Grace-Period (1,5 s im E2E-Lauf): gestoppt.
  await expect(projectsPage.statusChipIn(projectsPage.cardByName(name))).toHaveAttribute(
    'data-status',
    'stopped',
    { timeout: 10_000 },
  );
});
