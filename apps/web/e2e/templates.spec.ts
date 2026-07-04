import { expect, test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Testet die echten Templates end-to-end: startet ihren echten Dev-Server
 * (denselben Weg, den die Plattform in der Sandbox geht — `bun run dev` mit
 * PORT-Env) und prüft im Browser, dass die Startseite wirklich rendert.
 * Beim Fullstack-Template wird dabei der Vite-/graphql-Proxy mitgetestet.
 *
 * Diese Tests fahren echte Dev-Server hoch → großzügige Timeouts.
 */

const templatesRoot = fileURLToPath(new URL('../../../templates', import.meta.url));

interface DevServer {
  proc: ChildProcess;
  port: number;
}

function ensureInstalled(cwd: string): void {
  if (existsSync(`${cwd}/node_modules`)) return;
  const result = spawnSync('bun', ['install', '--silent'], { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`bun install fehlgeschlagen in ${cwd}`);
}

async function waitForHttp(port: number, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // Dev-Server bootet noch.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Template-Dev-Server auf Port ${port} wurde nicht erreichbar`);
}

function startDevServer(
  dir: string,
  port: number,
  extraEnv: Record<string, string> = {},
): DevServer {
  const cwd = `${templatesRoot}/${dir}`;
  ensureInstalled(cwd);
  const proc = spawn('bun', ['run', 'dev'], {
    cwd,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    detached: true,
    stdio: 'ignore',
  });
  return { proc, port };
}

async function stopDevServer(server: DevServer | null): Promise<void> {
  if (!server?.proc.pid) return;
  try {
    // Ganze Prozessgruppe beenden (Dev-Server startet Kindprozesse).
    process.kill(-server.proc.pid, 'SIGTERM');
  } catch {
    // schon beendet
  }
}

test.describe('Template "pwa" — Client-PWA rendert die Startseite', () => {
  let server: DevServer | null = null;

  test.beforeAll(async () => {
    server = startDevServer('pwa', 5191);
    await waitForHttp(5191);
  });

  test.afterAll(async () => {
    await stopDevServer(server);
  });

  test('zeigt Dashboard, Excel-Drop und einen gerenderten Recharts-Chart', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5191/');

    // React ist gemountet und die App-Startseite rendert echten Inhalt.
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible({
      timeout: 30_000,
    });
    // Excel-Upload-Zone (immer sichtbar, mit Beispieldaten-Hinweis).
    await expect(page.getByText(/Excel-Datei hierher ziehen/i)).toBeVisible();
    // Recharts rendert aus den eingebauten Beispieldaten einen Chart.
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible({ timeout: 30_000 });
  });
});

test.describe('Template "fullstack" — Startseite lädt Daten durch den /graphql-Proxy', () => {
  let server: DevServer | null = null;

  test.beforeAll(async () => {
    // Web auf 5192; der Template-Server nutzt intern Port 4000 (Vite proxied dorthin).
    server = startDevServer('fullstack', 5192);
    await waitForHttp(5192);
  });

  test.afterAll(async () => {
    await stopDevServer(server);
  });

  test('rendert "Notizen" und legt über den Proxy eine Notiz an', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('http://127.0.0.1:5192/');

    await expect(page.getByRole('heading', { name: /Notizen/i })).toBeVisible({ timeout: 30_000 });

    // Eine Notiz anlegen — der Weg geht durch den Vite-/graphql-Proxy zum
    // Template-Server und wieder zurück. Erscheint sie, funktioniert der Proxy.
    const text = `E2E-Notiz ${Date.now()}`;
    await page.getByPlaceholder(/Neue Notiz/i).fill(text);
    await page.getByRole('button').first().click();
    await expect(page.getByText(text)).toBeVisible({ timeout: 30_000 });
  });
});
