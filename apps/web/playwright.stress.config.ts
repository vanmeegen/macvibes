import { defineConfig, devices } from '@playwright/test';

/**
 * Stresstests für VM-Lebenszyklus und Turn-Handling gegen eine LAUFENDE
 * Testinstallation — echte MicroVMs, echter Claude. Nie gegen die produktive
 * Instanz: die Szenarien stoppen VMs von außen und beenden den Server.
 * Nicht Teil der CI. Hintergrund: docs/haertung-turn-und-vm-2026-11.md.
 *
 * Start über `bun run stress` (scripts/stress.ts): startet die
 * Testinstallation auf eigenen Ports, legt den Wegwerf-Nutzer an und räumt ab.
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
