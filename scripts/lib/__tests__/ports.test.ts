/**
 * Portermittlung der Repo-Skripte: der Web-Port MUSS auf denselben
 * Env-Namen hören wie Vite selbst (`MACVIBES_WEB_PORT`, siehe
 * apps/web/vite.config.ts und scripts/dev.ts). Historischer Fehler:
 * preflight/shutdown lasen `VITE_PORT` — mit gesetztem Override prüfte
 * der Preflight den falschen Port (kein Mehrfachstart-Schutz) und der
 * Shutdown meldete Erfolg, obwohl Vite weiterlief.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { portKonfiguration } from '../ports';

const ENV_NAMEN = [
  'MACVIBES_WEB_PORT',
  'VITE_PORT',
  'PORT',
  'MACVIBES_EGRESS_PORT',
  'MACVIBES_PREVIEW_GATEWAY_PORT',
] as const;

// process.env sauber sichern und wiederherstellen — die Tests dürfen keine
// Overrides in andere Tests (oder aus der CI-Umgebung) hineinlecken.
let gesichert: Partial<Record<(typeof ENV_NAMEN)[number], string | undefined>>;

beforeEach(() => {
  gesichert = {};
  for (const name of ENV_NAMEN) {
    gesichert[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_NAMEN) {
    const wert = gesichert[name];
    if (wert === undefined) delete process.env[name];
    else process.env[name] = wert;
  }
});

describe('portKonfiguration', () => {
  test('liefert ohne Overrides die Defaults', () => {
    expect(portKonfiguration()).toEqual({
      web: 5173,
      server: 4000,
      egress: 4010,
      gateway: 4173,
    });
  });

  test('MACVIBES_WEB_PORT übersteuert den Web-Port — der Name, den Vite konsumiert', () => {
    process.env['MACVIBES_WEB_PORT'] = '5174';
    expect(portKonfiguration().web).toBe(5174);
  });

  test('VITE_PORT hat KEINE Wirkung (wird im Repo nirgends gesetzt oder gelesen)', () => {
    process.env['VITE_PORT'] = '6000';
    expect(portKonfiguration().web).toBe(5173);
  });

  test('Server-, Egress- und Gateway-Overrides greifen wie dokumentiert', () => {
    process.env['PORT'] = '4001';
    process.env['MACVIBES_EGRESS_PORT'] = '4011';
    process.env['MACVIBES_PREVIEW_GATEWAY_PORT'] = '4174';
    expect(portKonfiguration()).toEqual({
      web: 5173,
      server: 4001,
      egress: 4011,
      gateway: 4174,
    });
  });
});
