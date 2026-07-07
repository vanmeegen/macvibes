import { expect, test } from '@playwright/test';
import {
  approvePendingViaApi,
  ensureAdminExists,
  getAdminCredentials,
  PASSWORD,
  registerNewUser,
  uniqueUsername,
} from './fixtures';
import { LoginPage } from './pages/loginPage';
import { ProjectsPage } from './pages/projectsPage';

// R10 — Login & Benutzer (Self-Registration + Admin-Freischaltung)

test('leitet Unangemeldete auf die Login-Seite um', async ({ page }) => {
  await page.goto('/');
  const loginPage = new LoginPage(page);
  await expect(loginPage.submitButton).toBeVisible();
  expect(page.url()).toContain('/login');
});

test('Selbst-Registrierung wartet auf Freischaltung (kein Auto-Login)', async ({ page }) => {
  await ensureAdminExists(); // damit dieser Nutzer NICHT der erste (Admin) ist
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.register(uniqueUsername(), PASSWORD);

  await expect(loginPage.noticeAlert).toBeVisible();
  await expect(new ProjectsPage(page).newProjectFab).not.toBeVisible();
});

test('nicht freigeschalteter Login wird abgewiesen; nach Freischaltung klappt er', async ({
  page,
}) => {
  await ensureAdminExists();
  const loginPage = new LoginPage(page);
  const username = uniqueUsername();
  await loginPage.goto();
  await loginPage.register(username, PASSWORD);

  // Login vor Freischaltung → generischer/abweisender Fehler.
  await loginPage.login(username, PASSWORD);
  await expect(loginPage.errorAlert).toBeVisible();

  // Admin schaltet frei → Login klappt.
  await approvePendingViaApi(username);
  await loginPage.login(username, PASSWORD);
  await expect(new ProjectsPage(page).newProjectFab).toBeVisible();
});

test('Admin sieht die Nutzerverwaltung und kann per UI freischalten', async ({ page }) => {
  // Ein pending-Nutzer, den der Admin gleich zulässt.
  const pendingUser = uniqueUsername();
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.register(pendingUser, PASSWORD);

  // Als Admin anmelden (im selben Browser-Kontext).
  const { username, password } = await getAdminCredentials();
  await loginPage.login(username, password);
  const projectsPage = new ProjectsPage(page);
  await expect(projectsPage.adminLink).toBeVisible();
  await projectsPage.adminLink.click();

  // Zeile des pending-Nutzers → „Zulassen" klicken → Status wird freigeschaltet.
  const row = page.locator(`[data-testselector="admin-user-row"][data-username="${pendingUser}"]`);
  await expect(row).toHaveAttribute('data-approved', 'false');
  await row.getByTestId('admin-approve').click();
  await expect(row).toHaveAttribute('data-approved', 'true');
});

test('Nicht-Admins sehen den Nutzerverwaltungs-Link nicht', async ({ page }) => {
  await registerNewUser(page); // regulärer, freigeschalteter Nutzer
  await expect(new ProjectsPage(page).adminLink).not.toBeVisible();
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
