import { expect, test, type Page } from '@playwright/test';
import { ChatPage } from '../e2e/pages/chatPage';
import { LoginPage } from '../e2e/pages/loginPage';
import { ProjectsPage } from '../e2e/pages/projectsPage';

/**
 * LIVE-Walkthrough gegen den LAUFENDEN Server (`bun run start`, Port 4000):
 * echte MicroVMs, echter Claude, echtes Preview-Gateway. Bewusst NICHT Teil
 * von `bun run ci` — Start: `bun run e2e:live` (in apps/web).
 *
 * Voraussetzungen:
 * - Server läuft (Default Port 4000, sonst MACVIBES_BASE_URL) mit msb +
 *   Credentials (apps/server/.env).
 * - Ein freigeschalteter Nutzer, dessen Zugangsdaten aus der Umgebung kommen:
 *   MACVIBES_LIVE_USER / MACVIBES_LIVE_PASS. Bewusst OHNE Default (F15) — ein
 *   Passwort im Repo wäre auf der laufenden Instanz sofort gültig.
 *
 * Prüft die Dinge, die das normale E2E (Fake-Agent, Prozess-Provider)
 * prinzipbedingt nicht kann: echter Claude-Kontext über Stop hinweg,
 * VM-Preview durchs Gateway, Trennung zweier echter Projekte.
 *
 * Nutzt die Page-Objects der normalen E2E-Suite, aber NICHT deren fixtures.ts:
 * die zieht playwright.config.ts mit, das beim Laden eine isolierte
 * Testumgebung anlegt.
 */
const USER = process.env.MACVIBES_LIVE_USER ?? '';
const PASS = process.env.MACVIBES_LIVE_PASS ?? '';

const SHOTS = 'test-results/live';
const STAMP = Date.now().toString(36);
const PWA = `walk-pwa-${STAMP}`;
const FULL = `walk-full-${STAMP}`;

/** Preview-URL: Gateway-Port mit `/p/<projectId>/` — nie der dynamische VM-Port. */
const GATEWAY_URL = /^https?:\/\/[^/]+:\d+\/p\/[^/]+\/$/;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.beforeAll(async ({ request, baseURL }) => {
  if (USER === '' || PASS === '') {
    throw new Error(
      'MACVIBES_LIVE_USER und MACVIBES_LIVE_PASS müssen gesetzt sein — der ' +
        'Live-Walkthrough läuft gegen die echte Instanz und hat bewusst keine ' +
        'Default-Zugangsdaten im Repo (F15).',
    );
  }
  // Fehlschlag = kein Server; der Grund steht in der Skip-Meldung.
  const up = await request.get('/').catch((err: unknown) => {
    console.warn(`Live-Server ${baseURL ?? ''} nicht erreichbar`, err);
    return null;
  });
  test.skip(up === null, `Kein laufender Server auf ${baseURL ?? ''} — e2e:live übersprungen.`);
});

test('Live-Walkthrough: Login → pwa+fullstack → Claude-Turn → Stop+Kontext → Trennung → Gateway-Preview', async ({
  page,
}) => {
  const loginPage = new LoginPage(page);
  const projectsPage = new ProjectsPage(page);
  const chatPage = new ChatPage(page);
  const assistant = chatPage.messagesByRole('assistant');

  /** Löscht ein Projekt über das Kartenmenü und wartet, bis die Karte weg ist. */
  const deleteProject = async (name: string): Promise<void> => {
    await projectsPage.deleteProject(name);
    await expect(projectsPage.cardByName(name)).toHaveCount(0);
  };

  // ── 1. Login ──
  await page.goto('/');
  await loginPage.usernameInput.fill(USER);
  await loginPage.passwordInput.fill(PASS);
  await shot(page, '01-login');
  await loginPage.submitButton.click();
  await expect(projectsPage.newProjectFab).toBeVisible({ timeout: 15_000 });
  await shot(page, '02-projekte');

  // ── 2. pwa-Projekt anlegen → Chat, VM bootet, Preview über das GATEWAY ──
  await projectsPage.createProject(PWA, 'pwa');
  await expect(chatPage.sandboxStatus).toHaveAttribute('data-status', 'running', {
    timeout: 90_000,
  });
  await expect(chatPage.previewIframe).toBeVisible({ timeout: 120_000 });
  expect(await chatPage.previewIframe.getAttribute('src')).toMatch(GATEWAY_URL);
  // Der Inhalt IM iframe rendert wirklich (Assets durchs Gateway geladen).
  await expect(chatPage.previewBody).toContainText(/Deine App|Erstellt mit/i, { timeout: 60_000 });
  await shot(page, '03-pwa-preview-gateway');

  // ── 3. Echter Claude-Turn (Kontext setzen) ──
  await chatPage.send('Merke dir das Codewort BLAUWAL. Antworte nur mit: ok');
  await expect(assistant.last()).toContainText(/ok/i, { timeout: 240_000 });
  await shot(page, '04-claude-antwortet');

  // ── 4. Langer Turn → STOP-Button → Folge-Turn mit Kontext ──
  await chatPage.send('Zähle langsam von 1 bis 40, jede Zahl mit einem ganzen Satz Erklärung.');
  await expect(chatPage.stopButton).toBeVisible({ timeout: 60_000 });
  await chatPage.stopButton.click();
  await expect(chatPage.stopButton).not.toBeVisible({ timeout: 30_000 });
  await shot(page, '05-nach-stop');
  await chatPage.send('Zusatzinfo: es ist ein Tier. Welches Codewort? Antworte nur damit.');
  await expect(assistant.last()).toContainText(/BLAUWAL/i, { timeout: 240_000 });
  await shot(page, '06-kontext-nach-stop');

  // ── 5. Zweites Projekt (fullstack) — Trennung: nichts vom pwa-Chat sichtbar ──
  await chatPage.backButton.click();
  await projectsPage.createProject(FULL, 'fullstack');
  await expect(chatPage.sandboxStatus).toHaveAttribute('data-status', 'running', {
    timeout: 90_000,
  });
  await page.waitForTimeout(2500); // Zeit für etwaige Leak-Events
  await expect(page.getByText('BLAUWAL')).toHaveCount(0);
  await expect(assistant).toHaveCount(0);
  await expect(chatPage.previewIframe).toBeVisible({ timeout: 120_000 });
  await expect(chatPage.previewBody).toContainText(/Notizen/i, { timeout: 90_000 });
  await shot(page, '07-fullstack-getrennt');

  // ── 6. Zurück zum pwa-Projekt: Verlauf unvermischt da ──
  await chatPage.backButton.click();
  await projectsPage.openProject(PWA);
  await expect(assistant.last()).toContainText(/BLAUWAL/i, { timeout: 30_000 });
  await shot(page, '08-pwa-verlauf-intakt');

  // ── 7. Aufräumen: beide Testprojekte löschen ──
  await chatPage.backButton.click();
  await deleteProject(PWA);
  await deleteProject(FULL);
});
