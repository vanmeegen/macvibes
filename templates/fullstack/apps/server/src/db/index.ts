import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Datenbank-Datei relativ zum Server-Paket (./data/app.db), beim Start angelegt.
const dataDir = join(import.meta.dir, '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(join(dataDir, 'app.db'), { create: true });
sqlite.run('PRAGMA journal_mode = WAL;');

// Einfache Inline-Migration — für ein Template reicht CREATE TABLE IF NOT EXISTS.
sqlite.run(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

export const db = drizzle(sqlite);
