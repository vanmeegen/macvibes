import { defineConfig, devices } from '@playwright/test';

/**
 * Stresstests für VM-Lebenszyklus und Turn-Handling gegen eine LAUFENDE
 * Testinstallation — echte MicroVMs, echter Claude. Nie gegen die produktive
 * Instanz: die Szenarien stoppen VMs von außen und beenden den Server.
 * Nicht Teil der CI. Hintergrund: docs/haertung-turn-und-vm-2026-11.md.
 *
 * Testinstallation daneben starten (eigene Ports, eigenes Home), z. B.:
 *   PORT=4100 MACVIBES_EGRESS_PORT=4110 MACVIBES_PREVIEW_GATEWAY_PORT=4273 \
 *   MACVIBES_GRACE_MS=8000 MACVIBES_HOME=<temp> DB_PATH=<temp>/app.db \
 *   bun run apps/server/src/index.ts
 * dann:
 *   MACVIBES_BASE_URL=http://127.0.0.1:4100 MACVIBES_LIVE_USER=… MACVIBES_LIVE_PASS=… \
 *   MACVIBES_LIVE_SERVER_LOG=<log> bunx playwright test --config playwright.stress.config.ts
 */
export default defineConfig({
  testDir: './e2e-stress',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.MACVIBES_BASE_URL ?? 'http://127.0.0.1:4100',
    testIdAttribute: 'data-testselector',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
