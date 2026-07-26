import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';

/**
 * Setzt Dateirechte, ohne bei fehlender Datei zu werfen (F25). WAL und SHM
 * entstehen erst beim ersten Schreibzugriff, deshalb best effort.
 */
function restrictAccess(path: string): void {
  try {
    if (existsSync(path)) chmodSync(path, 0o600);
  } catch (error) {
    console.warn(`Dateirechte für ${path} konnten nicht gesetzt werden:`, error);
  }
}

export function createDb(path: string) {
  if (path !== ':memory:') {
    // 0700: die DB enthält Session-Tokens im Klartext (direkt als Cookie
    // verwendbar) und alle Passwort-Hashes — kein Lesezugriff für andere
    // lokale Konten (F25).
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const sqlite = new Database(path, { create: true });
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') {
    try {
      chmodSync(dirname(path), 0o700);
    } catch (error) {
      console.warn(`Dateirechte für ${dirname(path)} konnten nicht gesetzt werden:`, error);
    }
    for (const file of [path, `${path}-wal`, `${path}-shm`]) restrictAccess(file);
  }
  return drizzle(sqlite);
}

export type Db = ReturnType<typeof createDb>;
