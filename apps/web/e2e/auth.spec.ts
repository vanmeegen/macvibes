import { expect, test } from '@playwright/test';
import { PASSWORD, registerNewUser, uniqueUsername } from './fixtures';
import { LoginPage } from './pages/loginPage';
import { ProjectsPage } from './pages/projectsPage';

// R10 — Login & Benutzer

test('leitet Unangemeldete auf die Login-Seite um', async ({ page }) => {
  await page.goto('/');
  const loginPage = new LoginPage(page);
  await expect(loginPage.submitButton).toBeVisible();
  expect(page.url()).toContain('/login');
});

test('lehnt Registrierung mit falschem Invite-Code ab', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.register(uniqueUsername(), PASSWORD, 'falscher-code');
  await expect(loginPage.errorAlert).toBeVisible();
  await expect(new ProjectsPage(page).newProjectFab).not.toBeVisible();
});

test('registriert mit Invite-Code und meldet direkt an', async ({ page }) => {
  const username = await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  await expect(projectsPage.currentUsername).toContainText(username);
});

test('Session überlebt einen Reload (Cookie)', async ({ page }) => {
  await registerNewUser(page);
  await page.reload();
  await expect(new ProjectsPage(page).newProjectFab).toBeVisible();
});

test('Logout meldet ab; falsches Passwort gibt generischen Fehler; korrektes Login klappt', async ({
  page,
}) => {
  const username = await registerNewUser(page);
  const projectsPage = new ProjectsPage(page);
  const loginPage = new LoginPage(page);

  await projectsPage.logout();
  await expect(loginPage.submitButton).toBeVisible();

  await loginPage.login(username, 'voellig-falsch');
  await expect(loginPage.errorAlert).toBeVisible();

  await loginPage.login(username, PASSWORD);
  await expect(projectsPage.newProjectFab).toBeVisible();
});
