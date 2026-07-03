import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Isolierte E2E-Umgebung: eigener Server-Port, frisches MACVIBES_HOME
 * (Bare-Repo) und frische SQLite-DB pro Testlauf — der normale Dev-Server
 * und die echte Datenbank bleiben unberührt.
 */
const E2E_HOME = mkdtempSync(join(tmpdir(), 'macvibes-e2e-'));
export const E2E_API_PORT = 4600;
export const E2E_WEB_PORT = 5175;
export const E2E_INVITE_CODE = 'e2e-code';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${E2E_WEB_PORT}`,
    testIdAttribute: 'data-testselector',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'bun run src/index.ts',
      cwd: '../server',
      url: `http://localhost:${E2E_API_PORT}/graphql?query=%7B__typename%7D`,
      reuseExistingServer: false,
      env: {
        PORT: String(E2E_API_PORT),
        HOST: '127.0.0.1',
        MACVIBES_HOME: E2E_HOME,
        DB_PATH: join(E2E_HOME, 'app.db'),
        MACVIBES_INVITE_CODE: E2E_INVITE_CODE,
        // Kurze Grace-Period, damit der R9-Lifecycle im E2E beobachtbar ist.
        MACVIBES_GRACE_MS: '1500',
        MACVIBES_IDLE_MS: '600000',
        // Deterministischer Agent statt echter Claude-API (R6-Tests).
        MACVIBES_AGENT: 'fake',
        MACVIBES_FAKE_DELAY_MS: '30',
        // Prozess-Provider: E2E testet die Plattform-Logik, nicht die VM.
        MACVIBES_SANDBOX: 'process',
      },
    },
    {
      command: `bunx vite --port ${E2E_WEB_PORT} --strictPort`,
      url: `http://localhost:${E2E_WEB_PORT}`,
      reuseExistingServer: false,
      env: {
        MACVIBES_API_PORT: String(E2E_API_PORT),
      },
    },
  ],
});
