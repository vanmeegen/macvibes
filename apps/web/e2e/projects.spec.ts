import { expect, test } from '@playwright/test';
import { getAdminCredentials, registerNewUser, uniqueProjectName } from './fixtures';
import { LoginPage } from './pages/loginPage';
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
  // Anlegen führt in den Chat — zurück zur Liste, um das neue Projekt zu sehen.
  await projectsPage.goto();

  const card = projectsPage.cardByName(name);
  await expect(card).toBeVisible();
  await expect(card).toContainText(username);
});

test('lehnt doppelte Projektnamen desselben Users verständlich ab', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const name = uniqueProjectName('Doppelt');

  await projectsPage.createProject(name, 'pwa');
  await projectsPage.goto();
  await expect(projectsPage.cardByName(name)).toBeVisible();

  // Zweite Anlage mit gleichem Namen: Dialog-Fehler, kein Wechsel in den Chat.
  await projectsPage.createProjectExpectingError(name, 'pwa');
  await expect(projectsPage.dialogError).toBeVisible();
});

test('Filter: „Nur meine" ist Default, „Alle" zeigt fremde Projekte ohne Kartenmenü', async ({
  page,
}) => {
  const projectsPage = new ProjectsPage(page);

  const ownerName = await registerNewUser(page);
  const foreignProject = uniqueProjectName('Fremdes Projekt');
  await projectsPage.createProject(foreignProject, 'pwa');
  await projectsPage.goto();
  await expect(projectsPage.cardByName(foreignProject)).toBeVisible();
  await projectsPage.logout();

  await registerNewUser(page);
  // Default „Nur meine": fremdes Projekt unsichtbar.
  await expect(projectsPage.newProjectFab).toBeVisible();
  await expect(projectsPage.cardByName(foreignProject)).not.toBeVisible();

  // „Alle": sichtbar, aber ohne Kartenmenü (Umbenennen/Löschen); Owner wird angezeigt.
  await projectsPage.filterAll.click();
  const foreignCard = projectsPage.cardByName(foreignProject);
  await expect(foreignCard).toBeVisible();
  await expect(foreignCard).toContainText(ownerName);
  await expect(projectsPage.menuButtonIn(foreignCard)).toHaveCount(0);
});

test('benennt ein eigenes Projekt über das Kartenmenü um', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const name = uniqueProjectName('Alter Name');
  const newName = uniqueProjectName('Neuer Name');

  await projectsPage.createProject(name, 'pwa');
  await projectsPage.goto();
  await expect(projectsPage.cardByName(name)).toBeVisible();

  await projectsPage.renameProject(name, newName);

  await expect(projectsPage.cardByName(newName)).toBeVisible();
  await expect(projectsPage.cardByName(name)).not.toBeVisible();
});

test('Admin kann fremde Projekte umbenennen und löschen', async ({ page }) => {
  // Normaler User legt ein Projekt an …
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const name = uniqueProjectName('Fremd');
  const newName = uniqueProjectName('Vom Admin');
  await projectsPage.createProject(name, 'pwa');
  await projectsPage.goto();
  await projectsPage.logout();

  // … der Admin sieht es unter „Alle" mit Kartenmenü und darf beides.
  const { username, password } = await getAdminCredentials();
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login(username, password);
  await expect(projectsPage.newProjectFab).toBeVisible();
  await projectsPage.filterAll.click();
  await expect(projectsPage.cardByName(name)).toBeVisible();

  await projectsPage.renameProject(name, newName);
  await expect(projectsPage.cardByName(newName)).toBeVisible();

  await projectsPage.deleteProject(newName);
  await expect(projectsPage.cardByName(newName)).not.toBeVisible();
});

test('löscht ein eigenes Projekt nach Bestätigung', async ({ page }) => {
  await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const name = uniqueProjectName('Wegwerf');

  await projectsPage.createProject(name, 'pwa');
  await projectsPage.goto();
  await expect(projectsPage.cardByName(name)).toBeVisible();

  await projectsPage.deleteProject(name);
  await expect(projectsPage.cardByName(name)).not.toBeVisible();
});
