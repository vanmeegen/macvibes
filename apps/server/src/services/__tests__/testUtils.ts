import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Db } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { register, type AuthConfig } from '../authService';
import type { UserRow } from '../../db/schema';

export const TEST_AUTH_CONFIG: AuthConfig = {
  inviteCode: 'test-code',
  sessionTtlMs: 3 * 24 * 60 * 60 * 1000,
};

export function createTestDb(): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Legt einen Templates-Ordner mit gültiger templates.json und einem Template an.
 * `templateDir` ist konfigurierbar, damit Baseline-Tests einen isolierten Namen
 * nutzen können und NIE die Produktions-Snapshots (macvibes-tpl-pwa) überschreiben.
 */
export async function createTemplatesFixture(templateDir = 'pwa'): Promise<string> {
  const dir = await createTempDir('macvibes-templates-');
  await mkdir(join(dir, templateDir));
  await writeFile(join(dir, templateDir, 'index.html'), '<!doctype html><title>PWA</title>');
  await writeFile(join(dir, templateDir, 'package.json'), JSON.stringify({ name: 'app' }));
  // Mini-Dev-Server für Preview-Tests: respektiert die PORT-Env (Template-Kontrakt).
  // Zählt bei jedem Start eine Zeile in .starts hoch — so lässt sich ein echter
  // Watchdog-Neustart (neue Instanz) vom bloßen Weiterlaufen unterscheiden.
  await writeFile(
    join(dir, templateDir, 'server.ts'),
    "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync('.starts', 'x\\n');\n" +
      "Bun.serve({ port: Number(process.env.PORT ?? 5199), fetch: () => new Response('hallo-preview') });\n",
  );
  await writeFile(
    join(dir, 'templates.json'),
    JSON.stringify({
      templates: [
        {
          name: 'Client-PWA',
          description: 'PWA ohne Server',
          dir: templateDir,
          devCommand: 'bun run dev',
          previewPort: 5173,
        },
      ],
    }),
  );
  return dir;
}

export async function createUser(db: Db, username = 'marco'): Promise<UserRow> {
  const result = await register(db, TEST_AUTH_CONFIG, {
    username,
    password: 'sicheres-passwort',
    inviteCode: TEST_AUTH_CONFIG.inviteCode,
  });
  return result.user;
}
