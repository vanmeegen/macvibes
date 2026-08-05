import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { supportsPosixModes } from '../../core/fsCapabilities';
import { createDb } from '../client';
import { createTempDir, removeDir } from '../../services/__tests__/testUtils';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

/**
 * F25: Die DB enthält Session-Tokens im Klartext (direkt als Cookie
 * verwendbar) und alle argon2id-Hashes. Sie darf keinem zweiten lokalen
 * Konto lesbar sein.
 */
describe('createDb — Dateirechte (F25)', () => {
  // Auf Dateisystemen ohne POSIX-Modes (NTFS) ist die Mode-Zusicherung
  // prinzipbedingt nicht prüfbar — dokumentierte Abschwächung, siehe
  // windows-portierung-plan.md (P5).
  test.skipIf(!supportsPosixModes(tmpdir()))(
    'legt DB mit 0600 und Verzeichnis mit 0700 an',
    async () => {
      const base = await createTempDir('macvibes-db-');
      tempDirs.push(base);
      const dataDir = join(base, 'data');
      const dbPath = join(dataDir, 'app.db');

      const db = createDb(dbPath);
      // Ein Schreibzugriff erzwingt das WAL, damit -wal/-shm entstehen.
      db.run(sql`CREATE TABLE probe (id integer primary key)`);

      expect(statSync(dbPath).mode & 0o077).toBe(0);
      expect(statSync(dataDir).mode & 0o077).toBe(0);
      for (const suffix of ['-wal', '-shm']) {
        const side = `${dbPath}${suffix}`;
        if (existsSync(side)) expect(statSync(side).mode & 0o077).toBe(0);
      }
      // Offene DB-Handles blockieren unter Windows das Aufräumen (EBUSY).
      db.$client.close();
    },
  );

  test('funktioniert auch ohne POSIX-Modes (öffnet, schreibt, schließt)', async () => {
    const base = await createTempDir('macvibes-db-');
    tempDirs.push(base);
    const db = createDb(join(base, 'data', 'app.db'));
    db.run(sql`CREATE TABLE probe (id integer primary key)`);
    db.$client.close();
  });
});
