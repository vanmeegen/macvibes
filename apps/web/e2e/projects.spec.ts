import { expect, test } from '@playwright/test';
import { registerNewUser, uniqueProjectName } from './fixtures';
import { ProjectsPage } from './pages/projectsPage';

// R1 — Projekt anlegen, R2 — Übersicht & Öffnen, R3 — Templates

test('bietet die Templates aus templates.json zur Auswahl an', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  await projectsPage.openCreateDialog();
  await expect(projectsPage.templateOption('pwa')).toBeVisible();
  await expect(projectsPage.templateOption('fullstack')).toBeVisible();
});

test('legt ein Projekt aus einem Template an und zeigt es in der Liste', async ({ page }) => {
  const username = await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const name = uniqueProjectName('Mein Dashboard');

  await projectsPage.createProject(name, 'pwa');

  const card = projectsPage.cardByName(name);
  await expect(card).toBeVisible();
  await expect(card).toContainText(username);
});

test('lehnt doppelte Projektnamen desselben Users verständlich ab', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const name = uniqueProjectName('Doppelt');

  await projectsPage.createProject(name, 'pwa');
  await expect(projectsPage.cardByName(name)).toBeVisible();

  await projectsPage.createProject(name, 'pwa');
  await expect(projectsPage.dialogError).toBeVisible();
});

test('Filter: „Nur meine" ist Default, „Alle" zeigt fremde Projekte ohne Lösch-Button', async ({
  page,
}) => {
  const projectsPage = new ProjectsPage(page);

  const ownerName = await registerNewUser(page);
  const foreignProject = uniqueProjectName('Fremdes Projekt');
  await projectsPage.createProject(foreignProject, 'pwa');
  await expect(projectsPage.cardByName(foreignProject)).toBeVisible();
  await projectsPage.logout();

  await registerNewUser(page);
  // Default „Nur meine": fremdes Projekt unsichtbar.
  await expect(projectsPage.newProjectFab).toBeVisible();
  await expect(projectsPage.cardByName(foreignProject)).not.toBeVisible();

  // „Alle": sichtbar, aber ohne Lösch-Button; Owner wird angezeigt.
  await projectsPage.filterAll.click();
  const foreignCard = projectsPage.cardByName(foreignProject);
  await expect(foreignCard).toBeVisible();
  await expect(foreignCard).toContainText(ownerName);
  await expect(projectsPage.deleteButtonIn(foreignCard)).toHaveCount(0);
});

test('löscht ein eigenes Projekt nach Bestätigung', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const name = uniqueProjectName('Wegwerf');

  await projectsPage.createProject(name, 'pwa');
  await expect(projectsPage.cardByName(name)).toBeVisible();

  await projectsPage.deleteProject(name);
  await expect(projectsPage.cardByName(name)).not.toBeVisible();
});
