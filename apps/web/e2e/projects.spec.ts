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

test('Filter: „Nur meine" ist Default; fremde Karten nur mit „Kopieren und Anpassen"', async ({
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

  // „Alle": sichtbar mit Menü — aber fremd nur Kopieren, kein Umbenennen/Löschen.
  await projectsPage.filterAll.click();
  const foreignCard = projectsPage.cardByName(foreignProject);
  await expect(foreignCard).toBeVisible();
  await expect(foreignCard).toContainText(ownerName);
  await projectsPage.menuButtonIn(foreignCard).click();
  await expect(projectsPage.copyMenuItem).toBeVisible();
  await expect(projectsPage.renameMenuItem).toHaveCount(0);
  await expect(projectsPage.deleteMenuItem).toHaveCount(0);
});

test('„Kopieren und Anpassen": fremdes Projekt forken, Fork gehört einem selbst', async ({
  page,
}) => {
  const projectsPage = new ProjectsPage(page);

  // User A legt ein Projekt an.
  await registerNewUser(page);
  const original = uniqueProjectName('Original');
  await projectsPage.createProject(original, 'pwa');
  await projectsPage.goto();
  await projectsPage.logout();

  // User B kopiert es über das Kartenmenü.
  const copierName = await registerNewUser(page);
  await projectsPage.filterAll.click();
  const copyName = uniqueProjectName('Mein Fork');
  await projectsPage.copyProject(original, copyName);
  // Anlegen führt direkt in den Chat des neuen Projekts.
  await page.waitForURL('**/projects/**');

  // Zurück zur Liste: der Fork gehört User B und hat das eigene Kartenmenü.
  await projectsPage.goto();
  const forkCard = projectsPage.cardByName(copyName);
  await expect(forkCard).toBeVisible();
  await expect(forkCard).toContainText(copierName);
  await projectsPage.menuButtonIn(forkCard).click();
  await expect(projectsPage.renameMenuItem).toBeVisible();
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
