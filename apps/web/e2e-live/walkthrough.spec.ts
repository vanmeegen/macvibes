import { expect, test, type Page } from '@playwright/test';

/**
 * LIVE-Walkthrough gegen den LAUFENDEN Server (`bun run start`, Port 4000):
 * echte MicroVMs, echter Claude, echtes Preview-Gateway. Bewusst NICHT Teil
 * von `bun run ci` — Start: `bun run e2e:live` (in apps/web).
 *
 * Voraussetzungen:
 * - Server läuft (Port 4000) mit msb + Credentials (apps/server/.env).
 * - Ein freigeschalteter Nutzer; Default browsertest/test1234!, übersteuerbar
 *   per MACVIBES_LIVE_USER / MACVIBES_LIVE_PASS.
 *
 * Prüft die Dinge, die das normale E2E (Fake-Agent, Prozess-Provider)
 * prinzipbedingt nicht kann: echter Claude-Kontext über Stop hinweg,
 * VM-Preview durchs Gateway, Trennung zweier echter Projekte.
 */
const USER = process.env.MACVIBES_LIVE_USER ?? 'browsertest';
const PASS = process.env.MACVIBES_LIVE_PASS ?? 'test1234!';
const SHOTS = 'test-results/live';
const STAMP = Date.now().toString(36);
const PWA = `walk-pwa-${STAMP}`;
const FULL = `walk-full-${STAMP}`;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function createProject(page: Page, name: string, templateDir: string): Promise<void> {
  await page.getByTestId('new-project-fab').click();
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId(`template-option-${templateDir}`).check();
  await page.getByTestId('new-project-submit').click();
  await page.waitForURL('**/projects/**');
}

async function deleteProject(page: Page, name: string): Promise<void> {
  const card = page
    .locator('[data-testselector^="project-card-"]:not([data-testselector^="project-card-link-"])')
    .filter({ hasText: name });
  await card.locator('[data-testselector^="project-delete-"]').click();
  await page.getByTestId('delete-confirm').click();
  await expect(card).toHaveCount(0);
}

async function sendChat(page: Page, text: string): Promise<void> {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
}

const assistant = (page: Page) =>
  page.locator('[data-testselector="chat-message"][data-role="assistant"]');

test.beforeAll(async ({ request }) => {
  const up = await request.get('http://localhost:4000/').catch(() => null);
  test.skip(up === null, 'Kein laufender Server auf :4000 — e2e:live übersprungen.');
});

test('Live-Walkthrough: Login → pwa+fullstack → Claude-Turn → Stop+Kontext → Trennung → Gateway-Preview', async ({
  page,
}) => {
  // ── 1. Login ──
  await page.goto('/');
  await page.getByTestId('login-username').fill(USER);
  await page.getByTestId('login-password').fill(PASS);
  await shot(page, '01-login');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('new-project-fab')).toBeVisible({ timeout: 15_000 });
  await shot(page, '02-projekte');

  // ── 2. pwa-Projekt anlegen → Chat, VM bootet, Preview über das GATEWAY ──
  await createProject(page, PWA, 'pwa');
  await expect(page.getByTestId('chat-sandbox-status')).toHaveAttribute('data-status', 'running', {
    timeout: 90_000,
  });
  const iframe = page.getByTestId('chat-preview');
  await expect(iframe).toBeVisible({ timeout: 120_000 });
  const src = await iframe.getAttribute('src');
  expect(src).toMatch(/^http:\/\/localhost:\d+\/p\/[^/]+\/$/); // Gateway-URL!
  // Der Inhalt IM iframe rendert wirklich (Assets durchs Gateway geladen).
  await expect(
    page.frameLocator('[data-testselector="chat-preview"]').locator('body'),
  ).toContainText(/Deine App|Erstellt mit/i, { timeout: 60_000 });
  await shot(page, '03-pwa-preview-gateway');

  // ── 3. Echter Claude-Turn (Kontext setzen) ──
  await sendChat(page, 'Merke dir das Codewort BLAUWAL. Antworte nur mit: ok');
  await expect(assistant(page).last()).toContainText(/ok/i, { timeout: 240_000 });
  await shot(page, '04-claude-antwortet');

  // ── 4. Langer Turn → STOP-Button → Folge-Turn mit Kontext ──
  await sendChat(page, 'Zähle langsam von 1 bis 40, jede Zahl mit einem ganzen Satz Erklärung.');
  await expect(page.getByTestId('chat-stop')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('chat-stop').click();
  await expect(page.getByTestId('chat-stop')).not.toBeVisible({ timeout: 30_000 });
  await shot(page, '05-nach-stop');
  await sendChat(page, 'Zusatzinfo: es ist ein Tier. Welches Codewort? Antworte nur damit.');
  await expect(assistant(page).last()).toContainText(/BLAUWAL/i, { timeout: 240_000 });
  await shot(page, '06-kontext-nach-stop');

  // ── 5. Zweites Projekt (fullstack) — Trennung: nichts vom pwa-Chat sichtbar ──
  await page.getByTestId('chat-back-button').click();
  await createProject(page, FULL, 'fullstack');
  await expect(page.getByTestId('chat-sandbox-status')).toHaveAttribute('data-status', 'running', {
    timeout: 90_000,
  });
  await page.waitForTimeout(2500); // Zeit für etwaige Leak-Events
  await expect(page.getByText('BLAUWAL')).toHaveCount(0);
  await expect(assistant(page)).toHaveCount(0);
  await expect(page.getByTestId('chat-preview')).toBeVisible({ timeout: 120_000 });
  await expect(
    page.frameLocator('[data-testselector="chat-preview"]').locator('body'),
  ).toContainText(/Notizen/i, { timeout: 90_000 });
  await shot(page, '07-fullstack-getrennt');

  // ── 6. Zurück zum pwa-Projekt: Verlauf unvermischt da ──
  await page.getByTestId('chat-back-button').click();
  await page
    .locator('[data-testselector^="project-card-"]:not([data-testselector^="project-card-link-"])')
    .filter({ hasText: PWA })
    .click();
  await expect(assistant(page).last()).toContainText(/BLAUWAL/i, { timeout: 30_000 });
  await shot(page, '08-pwa-verlauf-intakt');

  // ── 7. Aufräumen: beide Testprojekte löschen ──
  await page.getByTestId('chat-back-button').click();
  await deleteProject(page, PWA);
  await deleteProject(page, FULL);
});
