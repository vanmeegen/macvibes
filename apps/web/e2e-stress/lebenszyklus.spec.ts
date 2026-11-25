/**
 * Stresstests für VM-Lebenszyklus und Turn-Handling gegen eine LAUFENDE
 * Testinstallation (echte MicroVMs, echter Claude). Jeder Fall legt eigene
 * Projekte an. Nicht Teil der CI — Untersuchungswerkzeug.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ChatPage } from '../e2e/pages/chatPage';
import { LoginPage } from '../e2e/pages/loginPage';
import { ProjectsPage } from '../e2e/pages/projectsPage';

/** ANSI-Farbcodes im Server-Log (ohne Steuerzeichen im Regex-Literal). */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const USER = process.env.MACVIBES_LIVE_USER ?? '';
const PASS = process.env.MACVIBES_LIVE_PASS ?? '';
const SERVER_LOG = process.env.MACVIBES_LIVE_SERVER_LOG ?? '';
const GRACE_MS = Number(process.env.MACVIBES_LIVE_GRACE_MS ?? '8000');
const STAMP = Date.now().toString(36);
let zaehler = 0;
const name = (kurz: string): string => `st-${kurz}-${STAMP}-${zaehler++}`;

function vms(): string[] {
  const out = execFileSync('msb', ['list'], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((z) => z.startsWith('macvibes-'))
    .map((z) => z.replace(/\s+/g, ' ').trim());
}
function vmVon(id: string): string | undefined {
  return vms().find((z) => z.startsWith(`macvibes-${id} `));
}
function logSeit(marke: number): string {
  if (SERVER_LOG === '') return '';
  return readFileSync(SERVER_LOG, 'utf8').slice(marke).replace(ANSI, '');
}
function logMarke(): number {
  return SERVER_LOG === '' ? 0 : readFileSync(SERVER_LOG, 'utf8').length;
}
function auffaellig(log: string): string[] {
  return log
    .split('\n')
    .filter((z) =>
      /ERR |rror|fehlgeschlagen|schlug fehl|konnte nicht|Unhandled|geordnet beendet|warn/i.test(z),
    )
    .map((z) => z.slice(0, 260));
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

async function bereit(chat: ChatPage, timeout = 120_000): Promise<void> {
  await expect(chat.sandboxStatus).toHaveAttribute('data-status', 'running', { timeout });
  await expect(chat.previewIframe).toBeVisible({ timeout });
}

async function aufraeumen(page: Page, namen: string[]): Promise<void> {
  const projects = new ProjectsPage(page);
  await page.goto('/');
  for (const n of namen) {
    if ((await projects.cardByName(n).count()) === 0) continue;
    await projects.deleteProject(n);
    await expect(projects.cardByName(n)).toHaveCount(0, { timeout: 30_000 });
  }
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('S1 schnelles Rein/Raus: 8× öffnen und sofort zurück, danach läuft genau eine VM', async ({
  page,
}) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const n = name('reinraus');
  const marke = logMarke();
  await projects.createProject(n, 'pwa');
  const id = projektId(page);
  for (let i = 0; i < 8; i++) {
    await chat.backButton.click();
    await projects.openProject(n);
    await page.waitForTimeout(i * 120);
  }
  await bereit(chat);
  await expect(chat.previewBody).toContainText(/Deine App|Erstellt mit/i, { timeout: 60_000 });
  expect(vms().filter((z) => z.includes(id))).toHaveLength(1);
  console.log('S1 log:', auffaellig(logSeit(marke)));
  await aufraeumen(page, [n]);
  await page.waitForTimeout(3000);
  expect(vmVon(id)).toBeUndefined();
});

test('S2 Nachricht sofort nach dem Anlegen (VM bootet noch): Turn läuft durch', async ({
  page,
}) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const n = name('sofort');
  const marke = logMarke();
  await projects.createProject(n, 'pwa');
  await chat.send('Antworte nur mit: ok');
  await expect(chat.messagesByRole('assistant').last()).toContainText(/ok/i, { timeout: 240_000 });
  await bereit(chat);
  console.log('S2 log:', auffaellig(logSeit(marke)));
  await aufraeumen(page, [n]);
});

test('S3 Stopp direkt nach dem Senden, Doppelklick auf Stopp, dann Folge-Turn', async ({
  page,
}) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const n = name('stopp');
  const marke = logMarke();
  await projects.createProject(n, 'pwa');
  await bereit(chat);
  await chat.send('Für später: Mein Lieblingstier ist der Blauwal. Antworte nur mit: ok');
  await expect(chat.messagesByRole('assistant').last()).toContainText(/ok/i, { timeout: 240_000 });

  for (let runde = 0; runde < 3; runde++) {
    await chat.send('Zähle langsam von 1 bis 60, jede Zahl mit einem ganzen Satz Erklärung.');
    await expect(chat.stopButton).toBeVisible({ timeout: 60_000 });
    // Runde 0: sofort; Runde 1: Doppelklick; Runde 2: nach 2 s (mitten im Stream).
    if (runde === 2) await page.waitForTimeout(2000);
    await chat.stopButton.click();
    if (runde === 1) await chat.stopButton.click({ timeout: 1000 }).catch(() => undefined);
    await expect(chat.stopButton).not.toBeVisible({ timeout: 30_000 });
  }
  await chat.send('Welches Lieblingstier hatte ich genannt? Antworte nur mit dem Tiernamen.');
  await expect(chat.messagesByRole('assistant').last()).toContainText(/Blauwal/i, {
    timeout: 240_000,
  });
  await expect(chat.messagesByRole('error')).toHaveCount(0);
  console.log('S3 log:', auffaellig(logSeit(marke)));
  await aufraeumen(page, [n]);
});

test('S4 zwei Nachrichten kurz hintereinander: beide werden beantwortet, Reihenfolge stimmt', async ({
  page,
}) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const n = name('doppel');
  const marke = logMarke();
  await projects.createProject(n, 'pwa');
  await bereit(chat);
  await chat.send('Antworte nur mit dem Wort: EINS');
  await chat.chatInput.fill('Antworte nur mit dem Wort: ZWEI');
  // Senden während der erste Turn läuft (Steering/Queue) — was auch immer die UI anbietet.
  if (await chat.sendButton.isEnabled()) await chat.sendButton.click();
  else await chat.chatInput.press('Enter');
  await expect(chat.stopButton).not.toBeVisible({ timeout: 240_000 });
  await page.waitForTimeout(3000);
  await expect(chat.stopButton).not.toBeVisible({ timeout: 240_000 });
  const texte = await chat.messagesByRole('assistant').allInnerTexts();
  const user = await chat.messagesByRole('user').allInnerTexts();
  console.log('S4 user:', user, 'assistant:', texte);
  console.log('S4 log:', auffaellig(logSeit(marke)));
  expect(user).toHaveLength(2);
  expect(texte.join(' ')).toMatch(/ZWEI/i);
  await aufraeumen(page, [n]);
});

test('S5 Reload mitten im Turn: Antwort erscheint, kein hängendes "arbeitet"', async ({ page }) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const n = name('reload');
  const marke = logMarke();
  await projects.createProject(n, 'pwa');
  await bereit(chat);
  await chat.send('Zähle von 1 bis 25, jede Zahl mit einem kurzen Satz. Ende mit dem Wort FERTIG.');
  await expect(chat.stopButton).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(chat.messagesByRole('assistant').last()).toContainText(/FERTIG/i, {
    timeout: 240_000,
  });
  await expect(chat.stopButton).not.toBeVisible({ timeout: 30_000 });
  await expect(chat.sandboxStatus).toHaveAttribute('data-turn-active', 'false');
  // Danach geht ein weiterer Turn.
  await chat.send('Antworte nur mit: ok');
  await expect(chat.messagesByRole('assistant').last()).toContainText(/ok/i, { timeout: 240_000 });
  console.log('S5 log:', auffaellig(logSeit(marke)));
  await aufraeumen(page, [n]);
});

test('S6 Löschen, während die VM noch startet: keine verwaiste VM', async ({ page }) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const ergebnisse: string[] = [];
  for (const warteMs of [0, 400, 1500]) {
    const n = name('loeschen');
    const marke = logMarke();
    await projects.createProject(n, 'pwa');
    const id = projektId(page);
    await page.waitForTimeout(warteMs);
    await chat.backButton.click();
    await projects.deleteProject(n);
    await expect(projects.cardByName(n)).toHaveCount(0, { timeout: 30_000 });
    await page.waitForTimeout(12_000);
    const rest = vmVon(id);
    ergebnisse.push(
      `warte=${warteMs} vm=${rest ?? '-'} log=${JSON.stringify(auffaellig(logSeit(marke)))}`,
    );
  }
  console.log('S6:', ergebnisse);
  expect(ergebnisse.filter((e) => !e.includes('vm=-'))).toEqual([]);
});

test('S7 zwei Tabs auf demselben Projekt: VM bleibt, solange einer offen ist', async ({
  page,
  context,
}) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const n = name('tabs');
  const marke = logMarke();
  await projects.createProject(n, 'pwa');
  const id = projektId(page);
  await bereit(chat);
  const zweite = await (context as BrowserContext).newPage();
  await zweite.goto(page.url());
  await bereit(new ChatPage(zweite));
  // Ersten Tab schließen, länger als die Grace-Frist warten.
  await page.close();
  await zweite.waitForTimeout(GRACE_MS + 6000);
  expect(vmVon(id)).toMatch(/running/);
  await expect(new ChatPage(zweite).sandboxStatus).toHaveAttribute('data-status', 'running');
  // Zweiten Tab auf die Übersicht — danach muss die VM nach der Frist stoppen.
  await new ChatPage(zweite).backButton.click();
  await zweite.waitForTimeout(GRACE_MS + 8000);
  console.log('S7 vm nach Frist:', vmVon(id) ?? '-', auffaellig(logSeit(marke)));
  expect(vmVon(id)).toBeUndefined();
  await aufraeumen(zweite, [n]);
});

test('S8 VM stirbt unter der offenen Seite: Turn danach heilt oder meldet klar', async ({
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
  await page.waitForTimeout(6000);
  const statusNachTod = await chat.sandboxStatus.getAttribute('data-status');
  await chat.send('Antworte nur mit: ok');
  const antwort = chat.messagesByRole('assistant').last();
  const fehler = chat.messagesByRole('error').last();
  await expect(antwort.or(fehler)).toBeVisible({ timeout: 240_000 });
  await page.waitForTimeout(5000);
  console.log('S8:', {
    statusNachTod,
    statusJetzt: await chat.sandboxStatus.getAttribute('data-status'),
    assistant: await chat.messagesByRole('assistant').allInnerTexts(),
    error: await chat.messagesByRole('error').allInnerTexts(),
    vm: vmVon(id) ?? '-',
    log: auffaellig(logSeit(marke)),
  });
  await expect(antwort).toContainText(/ok/i, { timeout: 240_000 });
  await aufraeumen(page, [n]);
});

test('S9 schneller Wechsel zwischen drei Projekten: Chat und Preview gehören zum richtigen Projekt', async ({
  page,
}) => {
  const projects = new ProjectsPage(page);
  const chat = new ChatPage(page);
  const namen = [name('wechsel-a'), name('wechsel-b'), name('wechsel-c')];
  const marke = logMarke();
  const ids: string[] = [];
  for (const n of namen) {
    await projects.createProject(n, 'pwa');
    ids.push(projektId(page));
    await chat.backButton.click();
  }
  for (let runde = 0; runde < 4; runde++) {
    for (const n of namen) {
      await projects.openProject(n);
      await page.waitForTimeout(150 * runde);
      await chat.backButton.click();
    }
  }
  for (const [i, n] of namen.entries()) {
    await projects.openProject(n);
    await bereit(chat);
    expect(await chat.previewIframe.getAttribute('src')).toContain(ids[i] as string);
    await chat.backButton.click();
  }
  console.log('S9 vms:', vms(), auffaellig(logSeit(marke)));
  await aufraeumen(page, namen);
  await page.waitForTimeout(4000);
  for (const id of ids) expect(vmVon(id)).toBeUndefined();
});
