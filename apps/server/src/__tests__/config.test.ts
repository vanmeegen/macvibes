import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDbPath } from '../config';
import { createTempDir, removeDir } from '../services/__tests__/testUtils';

const tempDirs: string[] = [];
const savedEnv = { DB_PATH: Bun.env.DB_PATH, MACVIBES_TEST_MODE: Bun.env.MACVIBES_TEST_MODE };

afterEach(async () => {
  Bun.env.DB_PATH = savedEnv.DB_PATH;
  Bun.env.MACVIBES_TEST_MODE = savedEnv.MACVIBES_TEST_MODE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

/**
 * F7: Lag die DB unter dem Repo-Root, lieferte Vites /@fs/-Handler sie im LAN
 * aus — mitsamt der Session-Tokens. Neue Installationen legen sie deshalb ins
 * macvibes-Home; bestehende Installationen behalten ihren Pfad.
 */
describe('resolveDbPath (F7)', () => {
  test('DB_PATH hat immer Vorrang', () => {
    Bun.env.DB_PATH = '/tmp/explizit.db';
    expect(resolveDbPath('/beliebig')).toBe('/tmp/explizit.db');
  });

  test('ohne Alt-DB liegt die neue DB im macvibes-Home, nicht im Repo', async () => {
    delete Bun.env.DB_PATH;
    delete Bun.env.MACVIBES_TEST_MODE;
    const home = await createTempDir('macvibes-home-');
    tempDirs.push(home);
    // In einem Verzeichnis OHNE ./data/app.db — sonst greift zu Recht der
    // Bestandsschutz (der Testlauf selbst hat eine Alt-DB neben sich).
    const cwd = process.cwd();
    const leer = await createTempDir('macvibes-leer-');
    tempDirs.push(leer);
    process.chdir(leer);
    try {
      const path = resolveDbPath(home);
      expect(path).toBe(join(home, 'data', 'app.db'));
      expect(path.startsWith('./')).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  test('eine bestehende DB unter ./data wird weiter benutzt (Bestandsschutz)', async () => {
    delete Bun.env.DB_PATH;
    delete Bun.env.MACVIBES_TEST_MODE;
    const cwd = process.cwd();
    const sandbox = await createTempDir('macvibes-cwd-');
    tempDirs.push(sandbox);
    mkdirSync(join(sandbox, 'data'), { recursive: true });
    writeFileSync(join(sandbox, 'data', 'app.db'), '');
    process.chdir(sandbox);
    try {
      expect(resolveDbPath('/anderer/home')).toBe('./data/app.db');
    } finally {
      process.chdir(cwd);
    }
  });
});
