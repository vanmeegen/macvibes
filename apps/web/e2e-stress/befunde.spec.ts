/**
 * Zweite Runde Stresstests: gezielte Nachstellung der Befunde aus dem
 * Code-Review. Untersuchungswerkzeug, nicht Teil der CI.
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
async function zeilen(chat: ChatPage): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const rolle of ['user', 'assistant', 'system', 'error'] as const) {
    out[rolle] = (await chat.messagesByRole(rolle).allInnerTexts()).map((t) => t.slice(0, 160));
  }
  return out;
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('T1 Arbeits-Anzeige beim Senden während des VM-Boots: flackert sie weg?', async ({ page }) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const n = name('flacker');
  await projects.createProject(n, 'pwa');
  await bereit(chat);
  const id = projektId(page);
  // VM stoppen lassen: zurück zur Übersicht und Grace abwarten.
  await chat.backButton.click();
  await page.waitForTimeout(12_000);
  expect(vms().some((z) => z.includes(id) && z.includes('running'))).toBe(false);
  await projects.openProject(n);
  // Sofort senden, VM startet erst.
  const start = Date.now();
  await chat.send('Antworte nur mit: ok');
  const verlauf: string[] = [];
  let letzter = '';
  while (Date.now() - start < 120_000) {
    const aktiv = (await chat.sandboxStatus.getAttribute('data-turn-active')) ?? '?';
    const status = (await chat.sandboxStatus.getAttribute('data-status')) ?? '?';
    const stop = (await chat.stopButton.isVisible()) ? 'stop' : 'kein-stop';
    const jetzt = `${aktiv}/${status}/${stop}`;
    if (jetzt !== letzter) {
      verlauf.push(`${Date.now() - start}ms ${jetzt}`);
      letzter = jetzt;
    }
    if ((await chat.messagesByRole('assistant').count()) > 0 && aktiv === 'false') break;
    await page.waitForTimeout(150);
  }
  console.log('T1 Verlauf turn-active/status/stop:', verlauf);
  console.log('T1 Zeilen:', await zeilen(chat));
});

test('T2 Senden unmittelbar nach Stopp (ohne zu warten): Folge-Turn, Hinweiszeilen, Dauer', async ({
  page,
}) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const n = name('stoppsofort');
  const marke = logMarke();
  await projects.createProject(n, 'pwa');
  await bereit(chat);
  await chat.send('Für später: Mein Lieblingstier ist der Blauwal. Antworte nur mit: ok');
  await expect(chat.messagesByRole('assistant').last()).toContainText(/ok/i, { timeout: 240_000 });
  await chat.send('Zähle langsam von 1 bis 60, jede Zahl mit einem ganzen Satz Erklärung.');
  await expect(chat.stopButton).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await chat.chatInput.fill(
    'Welches Lieblingstier hatte ich genannt? Antworte nur mit dem Tiernamen.',
  );
  await chat.stopButton.click();
  const t0 = Date.now();
  // So schnell wie die UI es zulässt hinterher senden.
  await expect(chat.sendButton).toBeEnabled({ timeout: 30_000 });
  await chat.sendButton.click();
  const tGesendet = Date.now() - t0;
  await expect(chat.messagesByRole('assistant').last()).toContainText(/Blauwal/i, {
    timeout: 240_000,
  });
  console.log('T2:', { sendenNachStoppMs: tGesendet, antwortNachMs: Date.now() - t0 });
  console.log('T2 Zeilen:', await zeilen(chat));
  console.log(
    'T2 log:',
    logSeit(marke).filter((z) => /Gateway|abgebaut|verworfen|Daemon|zweiter|rejected|ERR/i.test(z)),
  );
});

test('T3 VM stirbt unter der offenen Seite: Zeiten, Anzeige, zweite Nachricht', async ({
  page,
}) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const n = name('tot');
  const marke = logMarke();
  await projects.createProject(n, 'pwa');
  const id = projektId(page);
  await bereit(chat);
  execFileSync('msb', ['stop', `macvibes-${id}`], { encoding: 'utf8' });
  await page.waitForTimeout(8000);
  const nachTod = {
    status: await chat.sandboxStatus.getAttribute('data-status'),
    iframe: await chat.previewIframe.isVisible(),
    hinweis: await chat.previewUnavailable.isVisible().catch(() => false),
  };
  const t0 = Date.now();
  await chat.send('Antworte nur mit: ok');
  const antwort = chat.messagesByRole('assistant').last();
  const fehler = chat.messagesByRole('error').last();
  await expect(antwort.or(fehler)).toBeVisible({ timeout: 400_000 });
  const ersteMs = Date.now() - t0;
  await expect(chat.stopButton).not.toBeVisible({ timeout: 120_000 });
  const nachErster = await zeilen(chat);
  const t1 = Date.now();
  await chat.send('Antworte nur mit: ok');
  await expect(chat.messagesByRole('assistant').last()).toContainText(/ok/i, { timeout: 400_000 });
  console.log('T3:', {
    nachTod,
    ersteNachrichtEndeMs: ersteMs,
    nachErster,
    zweiteNachrichtMs: Date.now() - t1,
    statusAmEnde: await chat.sandboxStatus.getAttribute('data-status'),
    vm: vms().filter((z) => z.includes(id)),
  });
  console.log(
    'T3 log:',
    logSeit(marke).filter((z) => z.includes(id) || /ERR|rror|Heil|kaputt|verschwunden/i.test(z)),
  );
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
  const pid = execFileSync('lsof', ['-nP', '-iTCP:4100', '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')[0] as string;
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
  console.log(
    'T4 VMs nach Server-Ende:',
    vms().filter((z) => z.includes(idB) || z.includes('running')),
  );
  console.log(
    'T4 log:',
    logSeit(marke).filter((z) => /Sandbox|SIGTERM|herunter|übersprungen|ERR|rror/i.test(z)),
  );
});
