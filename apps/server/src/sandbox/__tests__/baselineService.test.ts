import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  baselineExists,
  baselineSnapshotName,
  resolveBaselineSnapshotName,
} from '../baselineService';
import { createTemplatesFixture, removeDir } from '../../services/__tests__/testUtils';

describe('baselineSnapshotName', () => {
  test('leitet den Snapshot-Namen aus dem Template-Ordner ab', () => {
    expect(baselineSnapshotName('pwa')).toBe('macvibes-tpl-pwa');
    expect(baselineSnapshotName('fullstack')).toBe('macvibes-tpl-fullstack');
  });
});

describe('baselineExists', () => {
  test('liefert false für unbekannte Templates', async () => {
    expect(await baselineExists('gibt-es-sicher-nicht')).toBe(false);
  });
});

// Regression (2026-07-04): der Baseline-Fork-Test überschrieb die echte
// Produktions-Baseline macvibes-tpl-pwa, weil es keinen isolierten Namen gab.
// Diese Tests sichern den Isolations-Mechanismus deterministisch ab.
describe('resolveBaselineSnapshotName — Isolations-Mechanismus', () => {
  test('ohne Override: Produktionsname macvibes-tpl-<dir>', () => {
    expect(resolveBaselineSnapshotName({ templateDir: 'pwa' })).toBe('macvibes-tpl-pwa');
  });

  test('mit Override gewinnt der Override (so isolieren Tests ihre Snapshots)', () => {
    const name = resolveBaselineSnapshotName({ templateDir: 'pwa', snapshotName: 'bltest-abc' });
    expect(name).toBe('bltest-abc');
    // Entscheidend: der Override zeigt NICHT auf die Produktions-Baseline.
    expect(name).not.toBe(baselineSnapshotName('pwa'));
  });
});

describe('createTemplatesFixture — konfigurierbarer Template-Name', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      if (d) await removeDir(d);
    }
  });

  test('Default ist "pwa"', async () => {
    const dir = await createTemplatesFixture();
    dirs.push(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf8'));
    expect(manifest.templates[0].dir).toBe('pwa');
  });

  test('nimmt einen isolierten Namen an — Ordner UND templates.json passen', async () => {
    const isolated = 'bltest-xyz';
    const dir = await createTemplatesFixture(isolated);
    dirs.push(dir);
    // Der Template-Ordner heißt isoliert …
    expect(readFileSync(join(dir, isolated, 'server.ts'), 'utf8')).toContain('Bun.serve');
    // … und templates.json referenziert genau diesen Namen (nicht pwa).
    const manifest = JSON.parse(readFileSync(join(dir, 'templates.json'), 'utf8'));
    expect(manifest.templates[0].dir).toBe(isolated);
    expect(manifest.templates[0].dir).not.toBe('pwa');
  });
});
