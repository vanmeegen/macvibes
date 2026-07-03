import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { fileURLToPath } from 'node:url';
import type { Db } from './client';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
