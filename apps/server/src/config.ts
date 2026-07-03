import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  port: number;
  hostname: string;
  /** Basis-Verzeichnis für Bare-Repo, Volumes etc. */
  macvibesHome: string;
  /** Lokales Bare-Repo, in dem alle Projekt-Branches leben. */
  bareRepoPath: string;
  /** Ordner mit den Projekt-Templates (templates.json + Unterordner). */
  templatesDir: string;
  /** Registrierungscode — ohne ihn kann sich niemand registrieren. */
  inviteCode: string;
  dbPath: string;
  /** Login-Session: 3 Tage, rollierend verlängert. */
  sessionTtlMs: number;
  /** Gebautes Web-UI (wird ausgeliefert, falls vorhanden). */
  webDistDir: string;
}

const DEFAULT_TEMPLATES_DIR = resolve(
  fileURLToPath(new URL('../../../templates', import.meta.url)),
);
const DEFAULT_WEB_DIST_DIR = resolve(fileURLToPath(new URL('../../web/dist', import.meta.url)));

export function resolveDbPath(): string {
  if (Bun.env.DB_PATH) return Bun.env.DB_PATH;
  return Bun.env.MACVIBES_TEST_MODE === '1' ? './data/app-test.db' : './data/app.db';
}

export function loadConfig(): ServerConfig {
  const macvibesHome = Bun.env.MACVIBES_HOME ?? join(homedir(), 'macvibes');
  return {
    port: Number(Bun.env.PORT ?? 4000),
    hostname: Bun.env.HOST ?? '0.0.0.0',
    macvibesHome,
    bareRepoPath: join(macvibesHome, 'macvibes-apps.git'),
    templatesDir: Bun.env.MACVIBES_TEMPLATES_DIR ?? DEFAULT_TEMPLATES_DIR,
    inviteCode: Bun.env.MACVIBES_INVITE_CODE ?? 'macvibes',
    dbPath: resolveDbPath(),
    sessionTtlMs: 3 * 24 * 60 * 60 * 1000,
    webDistDir: Bun.env.MACVIBES_WEB_DIST ?? DEFAULT_WEB_DIST_DIR,
  };
}
