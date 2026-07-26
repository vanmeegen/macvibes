import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * F15: Im Repo stand ein Default-Passwort für einen realen, freigeschalteten
 * Account der LAUFENDEN Instanz — kein Fixture, sondern gültige Zugangsdaten.
 * Dieser Guard verhindert den Rückfall.
 */
describe('Live-Walkthrough enthält keine Zugangsdaten (F15)', () => {
  // Vitest läuft mit cwd = apps/web (jsdom-Umgebung, kein file:-import.meta.url).
  const source = readFileSync(resolve(process.cwd(), 'e2e-live/walkthrough.spec.ts'), 'utf8');

  it('liest Nutzer und Passwort ausschließlich aus der Umgebung', () => {
    expect(source).toContain('process.env.MACVIBES_LIVE_USER');
    expect(source).toContain('process.env.MACVIBES_LIVE_PASS');
  });

  it('enthält keinen Default-Wert hinter dem Env-Zugriff', () => {
    // `?? '...'` mit nicht-leerem Literal wäre wieder ein Secret im Repo.
    const defaults = source.match(/process\.env\.MACVIBES_LIVE_\w+\s*\?\?\s*'([^']*)'/g) ?? [];
    for (const hit of defaults) {
      expect(hit).toMatch(/\?\?\s*''$/);
    }
  });
});
