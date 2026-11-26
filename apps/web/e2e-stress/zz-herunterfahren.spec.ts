/**
 * A4 der Härtung 2026-11: Herunterfahren, während ein Projekt geöffnet wird.
 * Dieses Szenario BEENDET den Server der Testinstallation — deshalb eine
 * eigene Datei, die als letzte läuft (Dateiname beginnt mit „zz").
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ChatPage } from '../e2e/pages/chatPage';
import { LoginPage } from '../e2e/pages/loginPage';
import { ProjectsPage } from '../e2e/pages/projectsPage';

/** ANSI-Farbcodes im Server-Log (ohne Steuerzeichen im Regex-Literal). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const USER = process.env.MACVIBES_LIVE_USER ?? '';
const PASS = process.env.MACVIBES_LIVE_PASS ?? '';
const SERVER_LOG = process.env.MACVIBES_LIVE_SERVER_LOG ?? '';
const STAMP = Date.now().toString(36);
let zaehler = 0;
const name = (kurz: string): string => `s2-${kurz}-${STAMP}-${zaehler++}`;

function vms(): string[] {
  return execFileSync('msb', ['list'], { encoding: 'utf8' })
    .split('\n')
    .filter((z) => z.startsWith('macvibes-'))
    .map((z) => z.replace(/\s+/g, ' ').trim());
}
const logMarke = (): number => (SERVER_LOG === '' ? 0 : readFileSync(SERVER_LOG, 'utf8').length);
function logSeit(marke: number): string[] {
  if (SERVER_LOG === '') return [];
  return readFileSync(SERVER_LOG, 'utf8')
    .slice(marke)
    .replace(ANSI, '')
    .split('\n')
    .filter((z) => z.trim() !== '')
    .map((z) => z.slice(0, 220));
}
function projektId(page: Page): string {
  const m = /\/projects\/([0-9a-f-]+)/.exec(page.url());
  if (m === null || m[1] === undefined) throw new Error(`keine Projekt-URL: ${page.url()}`);
  return m[1];
}
async function login(page: Page): Promise<void> {
  const loginPage = new LoginPage(page);
  await page.goto('/');
  await loginPage.usernameInput.fill(USER);
  await loginPage.passwordInput.fill(PASS);
  await loginPage.submitButton.click();
  await expect(new ProjectsPage(page).newProjectFab).toBeVisible({ timeout: 15_000 });
}
async function bereit(chat: ChatPage): Promise<void> {
  await expect(chat.sandboxStatus).toHaveAttribute('data-status', 'running', { timeout: 120_000 });
  await expect(chat.previewIframe).toBeVisible({ timeout: 120_000 });
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('T4 Server fährt herunter, während ein Projekt geöffnet wird: bleibt eine VM übrig?', async ({
  page,
}) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const a = name('down-a');
  const b = name('down-b');
  await projects.createProject(a, 'pwa');
  await bereit(chat);
  await chat.backButton.click();
  await projects.createProject(b, 'pwa');
  const idB = projektId(page);
  await bereit(chat);
  await chat.backButton.click();
  // b ist jetzt ohne Betrachter (Grace läuft), a ebenso. Server stoppen und
  // sofort b wieder öffnen — das enter trifft auf den laufenden Stopp.
  const pid =
    process.env.MACVIBES_STRESS_SERVER_PID ??
    (execFileSync('lsof', ['-nP', '-iTCP:4100', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .trim()
      .split('\n')[0] as string);
  const marke = logMarke();
  process.kill(Number(pid), 'SIGTERM');
  await projects.openProject(b).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.reload().catch(() => undefined);
  // Warten, bis der Prozess weg ist.
  for (let i = 0; i < 120; i++) {
    try {
      process.kill(Number(pid), 0);
    } catch {
      break;
    }
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(3000);
  const rest = vms().filter((z) => z.includes(idB));
  const logZeilen = logSeit(marke).filter((z) =>
    /Sandbox|SIGTERM|herunter|übersprungen|ERR|rror/i.test(z),
  );
  console.log('T4 VMs nach Server-Ende:', rest);
  console.log('T4 log:', logZeilen);
  // A4: vor der Härtung stand hier „stopped", direkt danach „starting".
  const nachSigterm = logZeilen.slice(logZeilen.findIndex((z) => z.includes('SIGTERM')));
  expect(nachSigterm.filter((z) => z.endsWith(': starting'))).toEqual([]);
  expect(rest).toEqual([]);
});
