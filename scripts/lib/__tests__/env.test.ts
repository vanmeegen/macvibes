import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envWertMitDateiFallback, wertAusEnvDatei } from '../env';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env['MACVIBES_TEST_ENV_WERT'];
});

function envDatei(inhalt: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'macvibes-env-'));
  tempDirs.push(dir);
  const datei = join(dir, '.env');
  writeFileSync(datei, inhalt);
  return datei;
}

/**
 * K-7 aus dem Zustandsmaschinen-Audit: Der Server sieht apps/server/.env und
 * <macvibesHome>/.env, das Shutdown-Skript sah nur die Prozess-Env — ein dort
 * gesetztes MACVIBES_MAX_SANDBOXES ging an der Grace-Berechnung vorbei und
 * die Budget-Invariante galt nur auf dem Papier.
 */
describe('envWertMitDateiFallback', () => {
  test('Prozess-Env hat Vorrang vor den Dateien', () => {
    process.env['MACVIBES_TEST_ENV_WERT'] = 'aus-prozess';
    const datei = envDatei('MACVIBES_TEST_ENV_WERT=aus-datei\n');
    expect(envWertMitDateiFallback('MACVIBES_TEST_ENV_WERT', [datei])).toBe('aus-prozess');
  });

  test('fällt auf die erste Datei mit Treffer zurück', () => {
    const erste = envDatei('ANDERES=x\n');
    const zweite = envDatei('MACVIBES_TEST_ENV_WERT=32\n');
    expect(envWertMitDateiFallback('MACVIBES_TEST_ENV_WERT', [erste, zweite])).toBe('32');
  });

  test('ohne Treffer: undefined (Aufrufer nimmt seinen Default)', () => {
    const datei = envDatei('ANDERES=x\n');
    expect(envWertMitDateiFallback('MACVIBES_TEST_ENV_WERT', [datei])).toBeUndefined();
  });
});

describe('wertAusEnvDatei', () => {
  test('letzter Treffer gewinnt (dotenv-Semantik), Quotes abgestreift', () => {
    const datei = envDatei('MACVIBES_X=1\nexport MACVIBES_X="16"\n');
    expect(wertAusEnvDatei(datei, 'MACVIBES_X')).toBe('16');
  });

  test('fehlende Datei ist kein Fehler', () => {
    expect(wertAusEnvDatei('/gibt/es/nicht/.env', 'MACVIBES_X')).toBeUndefined();
  });
});
