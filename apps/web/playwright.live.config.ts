import { defineConfig, devices } from '@playwright/test';

/**
 * Live-Walkthrough gegen den LAUFENDEN Server (bun run start, Port 4000) —
 * echte MicroVMs, echter Claude, echtes Preview-Gateway. KEIN webServer-Start,
 * KEINE Test-Isolation: bewusst der reale Stand. Nur manuell ausführen:
 *   bunx playwright test --config playwright.live.config.ts
 */
export default defineConfig({
  testDir: './e2e-live',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4000',
    testIdAttribute: 'data-testselector',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
