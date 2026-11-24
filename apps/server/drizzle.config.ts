import { defineConfig } from 'drizzle-kit';

/**
 * Nur für `drizzle-kit generate` (bun run db:generate): erzeugt Migrationen
 * aus dem Schema. MIGRIERT wird nicht per drizzle-kit, sondern vom Server
 * selbst beim Start (src/db/migrate.ts) gegen die echte DB (config.dbPath,
 * im Normalfall unter ~/macvibes) — `dbCredentials` unten zeigt deshalb
 * bewusst NICHT auf die Live-Datenbank und wird von `generate` nicht gelesen.
 */
export default defineConfig({
  schema: './src/db/schema',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './data/app.db',
  },
});
