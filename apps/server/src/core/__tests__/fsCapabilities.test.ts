import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { supportsPosixModes } from '../fsCapabilities';

describe('supportsPosixModes (Feature-Detection statt Plattform-Weiche)', () => {
  test('charakterisiert die Plattform korrekt und räumt die Probedatei auf', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'macvibes-caps-'));
    try {
      // NTFS setzt keine POSIX-Modes durch, übliche POSIX-Dateisysteme schon.
      expect(supportsPosixModes(dir)).toBe(process.platform !== 'win32');
      expect(readdirSync(dir)).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('liefert false für ein nicht existentes Verzeichnis', () => {
    expect(supportsPosixModes(join(tmpdir(), 'gibt-es-nicht-9x7'))).toBe(false);
  });
});
