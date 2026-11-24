import {
  ADMIN_CREDENTIALS,
  approvePendingViaApi,
  expect,
  PASSWORD,
  registerNewUser,
  test,
  uniqueUsername,
} from './fixtures';

// R10 — Login & Benutzer (Self-Registration + Admin-Freischaltung)

test('leitet Unangemeldete auf die Login-Seite um', async ({ page, loginPage }) => {
  await page.goto('/');
  await expect(loginPage.submitButton).toBeVisible();
  expect(page.url()).toContain('/login');
});

test('Selbst-Registrierung wartet auf Freischaltung (kein Auto-Login)', async ({
  loginPage,
  projectsPage,
}) => {
  await loginPage.goto();
  await loginPage.register(uniqueUsername(), PASSWORD);

  await expect(loginPage.noticeAlert).toBeVisible();
  await expect(projectsPage.newProjectFab).not.toBeVisible();
});

test('nicht freigeschalteter Login wird abgewiesen; nach Freischaltung klappt er', async ({
  loginPage,
  projectsPage,
}) => {
  const username = uniqueUsername();
  await loginPage.goto();
  await loginPage.register(username, PASSWORD);

  // Login vor Freischaltung → generischer/abweisender Fehler.
  await loginPage.login(username, PASSWORD);
  await expect(loginPage.errorAlert).toBeVisible();

  // Admin schaltet frei → Login klappt.
  await approvePendingViaApi(username);
  await loginPage.login(username, PASSWORD);
  await expect(projectsPage.newProjectFab).toBeVisible();
});

test('Admin sieht die Nutzerverwaltung und kann per UI freischalten', async ({
  loginPage,
  projectsPage,
  adminPage,
}) => {
  // Ein pending-Nutzer, den der Admin gleich zulässt.
  const pendingUser = uniqueUsername();
  await loginPage.goto();
  await loginPage.register(pendingUser, PASSWORD);

  // Als Admin anmelden (im selben Browser-Kontext).
  await loginPage.login(ADMIN_CREDENTIALS.username, ADMIN_CREDENTIALS.password);
  await expect(projectsPage.adminLink).toBeVisible();
  await projectsPage.adminLink.click();

  // Zeile des pending-Nutzers → „Zulassen" klicken → Status wird freigeschaltet.
  const row = adminPage.userRow(pendingUser);
  await expect(row).toHaveAttribute('data-approved', 'false');
  await adminPage.approveButtonIn(row).click();
  await expect(row).toHaveAttribute('data-approved', 'true');
});

test('Nicht-Admins sehen den Nutzerverwaltungs-Link nicht', async ({ page, projectsPage }) => {
  await registerNewUser(page); // regulärer, freigeschalteter Nutzer
  await expect(projectsPage.adminLink).not.toBeVisible();
});

test('Session überlebt einen Reload (Cookie)', async ({ page, projectsPage }) => {
  await registerNewUser(page);
  await page.reload();
  await expect(projectsPage.newProjectFab).toBeVisible();
});

test('Logout meldet ab; falsches Passwort gibt generischen Fehler; korrektes Login klappt', async ({
  page,
  loginPage,
  projectsPage,
}) => {
  const username = await registerNewUser(page);

  await projectsPage.logout();
  await expect(loginPage.submitButton).toBeVisible();

  await loginPage.login(username, 'voellig-falsch');
  await expect(loginPage.errorAlert).toBeVisible();

  await loginPage.login(username, PASSWORD);
  await expect(projectsPage.newProjectFab).toBeVisible();
});
