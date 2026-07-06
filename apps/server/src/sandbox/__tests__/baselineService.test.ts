import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  baselineExists,
  baselineSnapshotName,
  resolveBaselineSnapshotName,
  baselineBootstrapScript,
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

describe('baselineBootstrapScript — verlinkt ALLE node_modules der Baseline (Workspaces)', () => {
  test('Root- und Workspace-node_modules werden gelinkt, innere (.bun) nicht', async () => {
    const { mkdtempSync, mkdirSync, existsSync, readlinkSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const base = mkdtempSync(join(tmpdir(), 'mv-baseline-'));
    const work = mkdtempSync(join(tmpdir(), 'mv-work-'));
    // Baseline-Layout wie beim fullstack-Template (Workspaces, hoisted + per-App):
    for (const d of [
      'node_modules/.bin',
      'node_modules/.bun/node_modules',
      'apps/web/node_modules/.bin',
      'apps/server/node_modules',
    ]) {
      mkdirSync(join(base, d), { recursive: true });
    }
    // Workspace hat die App-Ordner (aus git), aber keine node_modules:
    mkdirSync(join(work, 'apps/web'), { recursive: true });
    mkdirSync(join(work, 'apps/server'), { recursive: true });

    const proc = Bun.spawn(['sh', '-c', baselineBootstrapScript], {
      cwd: work,
      env: { ...process.env, MV_BASELINE: base },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);

    expect(readlinkSync(join(work, 'node_modules'))).toBe(join(base, 'node_modules'));
    expect(readlinkSync(join(work, 'apps/web/node_modules'))).toBe(
      join(base, 'apps/web/node_modules'),
    );
    expect(readlinkSync(join(work, 'apps/server/node_modules'))).toBe(
      join(base, 'apps/server/node_modules'),
    );
    // Innere node_modules (.bun) dürfen NICHT als eigener Link auftauchen.
    expect(existsSync(join(work, 'node_modules/.bun'))).toBe(true); // via Root-Link erreichbar
  });

  test('idempotent: existierende node_modules werden nicht überschrieben', async () => {
    const { mkdtempSync, mkdirSync, lstatSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = mkdtempSync(join(tmpdir(), 'mv-baseline-'));
    const work = mkdtempSync(join(tmpdir(), 'mv-work-'));
    mkdirSync(join(base, 'node_modules'), { recursive: true });
    mkdirSync(join(work, 'node_modules'), { recursive: true }); // echtes Verzeichnis vorhanden

    const proc = Bun.spawn(['sh', '-c', baselineBootstrapScript], {
      cwd: work,
      env: { ...process.env, MV_BASELINE: base },
    });
    expect(await proc.exited).toBe(0);
    // bleibt ein echtes Verzeichnis, kein Symlink
    expect(lstatSync(join(work, 'node_modules')).isSymbolicLink()).toBe(false);
  });
});
