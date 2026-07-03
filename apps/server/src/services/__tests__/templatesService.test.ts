import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTemplates } from '../templatesService';
import { createTempDir, createTemplatesFixture, removeDir } from './testUtils';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

function collectWarnings(): { warnings: string[]; logger: { warn(m: string): void } } {
  const warnings: string[] = [];
  return { warnings, logger: { warn: (m: string) => warnings.push(m) } };
}

describe('loadTemplates', () => {
  test('liefert gültige Templates aus templates.json', async () => {
    const dir = await createTemplatesFixture();
    tempDirs.push(dir);
    const { logger } = collectWarnings();
    const templates = await loadTemplates(dir, logger);
    expect(templates).toHaveLength(1);
    expect(templates[0]?.dir).toBe('pwa');
    expect(templates[0]?.previewPort).toBe(5173);
  });

  test('filtert Einträge ohne Ordner heraus und warnt', async () => {
    const dir = await createTemplatesFixture();
    tempDirs.push(dir);
    await writeFile(
      join(dir, 'templates.json'),
      JSON.stringify({
        templates: [
          {
            name: 'Fehlt',
            description: 'Ordner existiert nicht',
            dir: 'gibt-es-nicht',
            devCommand: 'bun run dev',
            previewPort: 5173,
          },
        ],
      }),
    );
    const { warnings, logger } = collectWarnings();
    const templates = await loadTemplates(dir, logger);
    expect(templates).toHaveLength(0);
    expect(warnings.some((w) => w.includes('gibt-es-nicht'))).toBe(true);
  });

  test('warnt über Ordner ohne Eintrag in templates.json', async () => {
    const dir = await createTemplatesFixture();
    tempDirs.push(dir);
    await mkdir(join(dir, 'verwaist'));
    const { warnings, logger } = collectWarnings();
    await loadTemplates(dir, logger);
    expect(warnings.some((w) => w.includes('verwaist'))).toBe(true);
  });

  test('fehlende templates.json ergibt leere Liste plus Warnung', async () => {
    const dir = await createTempDir('macvibes-empty-');
    tempDirs.push(dir);
    const { warnings, logger } = collectWarnings();
    expect(await loadTemplates(dir, logger)).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  test('kaputtes JSON ergibt leere Liste plus Warnung', async () => {
    const dir = await createTempDir('macvibes-broken-');
    tempDirs.push(dir);
    await writeFile(join(dir, 'templates.json'), '{ kaputt');
    const { warnings, logger } = collectWarnings();
    expect(await loadTemplates(dir, logger)).toHaveLength(0);
    expect(warnings.some((w) => w.includes('JSON'))).toBe(true);
  });
});
