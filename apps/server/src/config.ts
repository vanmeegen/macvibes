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
  sandbox: {
    /** Stopp-Verzögerung nach Verlassen der Chat-Page (R9, Default 15 min). */
    graceMs: number;
    /** Stopp nach Agent-Inaktivität (R9, Default 30 min). */
    idleMs: number;
    /** Maximal gleichzeitige Sandboxes (R9, Default 8). */
    maxSandboxes: number;
  };
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
    sandbox: {
      graceMs: Number(Bun.env.MACVIBES_GRACE_MS ?? 15 * 60 * 1000),
      idleMs: Number(Bun.env.MACVIBES_IDLE_MS ?? 30 * 60 * 1000),
      maxSandboxes: Number(Bun.env.MACVIBES_MAX_SANDBOXES ?? 8),
    },
  };
}
