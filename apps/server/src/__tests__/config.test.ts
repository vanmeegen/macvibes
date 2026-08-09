import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig,
  loadHomeEnvFile,
  parseEnvFile,
  resolveDbPath,
  resolveEnvPrecedence,
} from '../config';
import { PORT_DEFAULTS } from '../../../../scripts/lib/ports';
import { createTempDir, removeDir } from '../services/__tests__/testUtils';

const tempDirs: string[] = [];
const savedEnv = { DB_PATH: Bun.env.DB_PATH, MACVIBES_TEST_MODE: Bun.env.MACVIBES_TEST_MODE };

afterEach(async () => {
  Bun.env.DB_PATH = savedEnv.DB_PATH;
  Bun.env.MACVIBES_TEST_MODE = savedEnv.MACVIBES_TEST_MODE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

/**
 * F7: Lag die DB unter dem Repo-Root, lieferte Vites /@fs/-Handler sie im LAN
 * aus — mitsamt der Session-Tokens. Neue Installationen legen sie deshalb ins
 * macvibes-Home; bestehende Installationen behalten ihren Pfad.
 *
 * Verpackungs-Fix: Der Legacy-Ort wird DETERMINISTISCH gegen das Server-Modul
 * aufgelöst (Parameter serverRoot, Default = <serverRoot> via import.meta.url),
 * NICHT mehr relativ zum cwd — sonst sah eine Homebrew-Installation (fremder
 * cwd) die Bestandsdaten nicht und legte eine frische DB im Home an.
 */
describe('resolveDbPath (F7)', () => {
  test('DB_PATH hat immer Vorrang', () => {
    Bun.env.DB_PATH = '/tmp/explizit.db';
    expect(resolveDbPath('/beliebig')).toBe('/tmp/explizit.db');
  });

  test('ohne Alt-DB liegt die neue DB im macvibes-Home, nicht im Repo', async () => {
    delete Bun.env.DB_PATH;
    delete Bun.env.MACVIBES_TEST_MODE;
    const home = await createTempDir('macvibes-home-');
    tempDirs.push(home);
    // serverRoot ohne data/ → kein Bestandsschutz, es greift der Home-Ort.
    const serverRoot = await createTempDir('macvibes-server-');
    tempDirs.push(serverRoot);
    const path = resolveDbPath(home, serverRoot);
    expect(path).toBe(join(home, 'data', 'app.db'));
    expect(path.startsWith('./')).toBe(false);
  });

  test('das Ergebnis hängt NICHT am Arbeitsverzeichnis (aus zwei cwd gleich)', async () => {
    delete Bun.env.DB_PATH;
    delete Bun.env.MACVIBES_TEST_MODE;
    const home = await createTempDir('macvibes-home-');
    tempDirs.push(home);
    const serverRoot = await createTempDir('macvibes-server-');
    tempDirs.push(serverRoot);
    const cwd = process.cwd();
    const a = await createTempDir('macvibes-cwd-a-');
    const b = await createTempDir('macvibes-cwd-b-');
    tempDirs.push(a, b);
    try {
      process.chdir(a);
      const ausA = resolveDbPath(home, serverRoot);
      process.chdir(b);
      const ausB = resolveDbPath(home, serverRoot);
      expect(ausA).toBe(ausB);
      expect(ausA).toBe(join(home, 'data', 'app.db'));
    } finally {
      process.chdir(cwd);
    }
  });

  test('eine bestehende DB unter <serverRoot>/data wird weiter benutzt (Bestandsschutz, cwd-unabhängig)', async () => {
    delete Bun.env.DB_PATH;
    delete Bun.env.MACVIBES_TEST_MODE;
    const serverRoot = await createTempDir('macvibes-server-');
    tempDirs.push(serverRoot);
    mkdirSync(join(serverRoot, 'data'), { recursive: true });
    writeFileSync(join(serverRoot, 'data', 'app.db'), '');
    const cwd = process.cwd();
    const anderer = await createTempDir('macvibes-cwd-');
    tempDirs.push(anderer);
    process.chdir(anderer);
    try {
      // Trotz fremdem cwd gewinnt die Legacy-DB am Server-Modul-Ort.
      expect(resolveDbPath('/anderer/home', serverRoot)).toBe(join(serverRoot, 'data', 'app.db'));
    } finally {
      process.chdir(cwd);
    }
  });
});

/**
 * Verpackungs-Fix Konfig-Vorrang: Eine installierte Fassung liest ihre Konfig
 * aus <macvibesHome>/.env (upgrade-fest), ein Dev-Checkout aus apps/server/.env.
 * Vorrang: (1) explizite Env > (2) apps/server/.env > (3) <macvibesHome>/.env.
 * Die reine Auflösungslogik wird OHNE Prozess-Env-Mutation getestet.
 */
describe('Konfig-Vorrang: Env > Repo-.env > Home-.env', () => {
  test('parseEnvFile: Kommentare/Leerzeilen ignoriert, Quotes entfernt, ohne $-Expansion', () => {
    const parsed = parseEnvFile(
      [
        '# Kommentar',
        '',
        "MACVIBES_ADMIN_USERNAME='marco'",
        'MACVIBES_SANDBOX=process',
        'DOPPELT="wert"',
        // $ bleibt literal — anders als Buns cwd-Autolader (keine Expansion hier).
        "ROH='a$HOME'",
      ].join('\n'),
    );
    expect(parsed['MACVIBES_ADMIN_USERNAME']).toBe('marco');
    expect(parsed['MACVIBES_SANDBOX']).toBe('process');
    expect(parsed['DOPPELT']).toBe('wert');
    expect(parsed['ROH']).toBe('a$HOME');
  });

  test('resolveEnvPrecedence: explizite Env schlägt Repo-.env schlägt Home-.env', () => {
    const merged = resolveEnvPrecedence(
      { K: 'aus-env' },
      { K: 'aus-repo', R: 'aus-repo' },
      { K: 'aus-home', R: 'aus-home', H: 'aus-home' },
    );
    expect(merged['K']).toBe('aus-env'); // Regel 1 gewinnt
    expect(merged['R']).toBe('aus-repo'); // Regel 2 vor Regel 3
    expect(merged['H']).toBe('aus-home'); // nur in Home → übernommen
  });

  test('resolveEnvPrecedence: undefined in der Env verdeckt keinen Fallback', () => {
    const merged = resolveEnvPrecedence({ K: undefined }, {}, { K: 'aus-home' });
    expect(merged['K']).toBe('aus-home');
  });

  test('loadHomeEnvFile füllt nur fehlende Keys (Regel 1&2 bleiben unangetastet)', async () => {
    const dir = await createTempDir('macvibes-homeenv-');
    tempDirs.push(dir);
    const KEY_GESETZT = 'MACVIBES_TEST_HOMEENV_GESETZT';
    const KEY_FEHLT = 'MACVIBES_TEST_HOMEENV_FEHLT';
    const saved = { g: Bun.env[KEY_GESETZT], f: Bun.env[KEY_FEHLT] };
    try {
      Bun.env[KEY_GESETZT] = 'bereits-gesetzt';
      delete Bun.env[KEY_FEHLT];
      writeFileSync(join(dir, '.env'), `${KEY_GESETZT}='aus-home'\n${KEY_FEHLT}='aus-home'\n`);
      loadHomeEnvFile(join(dir, '.env'));
      expect(Bun.env[KEY_GESETZT]).toBe('bereits-gesetzt'); // NICHT überschrieben
      expect(Bun.env[KEY_FEHLT]).toBe('aus-home'); // Fallback geladen
    } finally {
      if (saved.g === undefined) delete Bun.env[KEY_GESETZT];
      else Bun.env[KEY_GESETZT] = saved.g;
      if (saved.f === undefined) delete Bun.env[KEY_FEHLT];
      else Bun.env[KEY_FEHLT] = saved.f;
    }
  });

  test('loadHomeEnvFile ohne Datei ist ein No-Op (kein Wurf)', () => {
    expect(() => loadHomeEnvFile(join('/nicht/vorhanden', '.env'))).not.toThrow();
  });
});

/**
 * M6: config.ts ist die EINE Quelle für Env-Reads des Servers. Vorher lasen
 * index.ts, createAppYoga (pro Request!), rateLimiter, authService,
 * egressPolicy und claudeRunner an ihr vorbei direkt aus Bun.env.
 */
describe('loadConfig zentralisiert die früher verstreuten Env-Reads (M6)', () => {
  const KEYS = [
    'MACVIBES_EGRESS_PORT',
    'MACVIBES_EGRESS_PORTS',
    'MACVIBES_PROXY_KEEPALIVE_MS',
    'MACVIBES_ALLOW_HOST_AGENT',
    'MACVIBES_AGENT_IDLE_TIMEOUT_MS',
    'MACVIBES_AGENT_FIRST_EVENT_TIMEOUT_MS',
    'MACVIBES_AGENT_COLD_START_TIMEOUT_MS',
    'MACVIBES_AGENT_WARMUP_TIMEOUT_MS',
    'MACVIBES_AGENT_SLOW_IDLE_TIMEOUT_MS',
    'MACVIBES_AGENT_SLOW_FIRST_EVENT_TIMEOUT_MS',
    'MACVIBES_AGENT_SLOW_COLD_START_TIMEOUT_MS',
    'MACVIBES_AGENT_APPEND_PROMPT',
    'MACVIBES_WEB_PORT',
    'MACVIBES_ALLOWED_ORIGINS',
    'MACVIBES_DEBUG_ERRORS',
    'MACVIBES_RATE_LIMIT_DISABLED',
    'MACVIBES_FORCE_ADMIN',
    'PORT',
    'MACVIBES_PREVIEW_GATEWAY_PORT',
  ] as const;
  const saved = new Map<string, string | undefined>(KEYS.map((k) => [k, Bun.env[k]]));

  function clearAll(): void {
    for (const key of KEYS) delete Bun.env[key];
  }

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  });

  test('Defaults ohne gesetzte Env-Variablen', () => {
    clearAll();
    const config = loadConfig();
    expect(config.egress.port).toBe(4010);
    expect(config.egress.allowedPorts).toEqual([80, 443]);
    expect(config.anthropic.keepAliveMs).toBeUndefined();
    expect(config.agent.allowHostAgent).toBe(false);
    expect(config.agent.appendSystemPrompt).toBeNull();
    expect(Object.values(config.agent.timeouts).every((t) => t === undefined)).toBe(true);
    expect(config.devWebPort).toBeNull();
    expect(config.allowedOrigins).toEqual([]);
    expect(config.debugErrors).toBe(false);
    expect(config.rateLimitDisabled).toBe(false);
    expect(config.forceAdmin).toBe(false);
  });

  test('Env-Overrides landen geparst in der Config', () => {
    clearAll();
    Bun.env.MACVIBES_EGRESS_PORT = '4011';
    Bun.env.MACVIBES_EGRESS_PORTS = '443, 8443, unfug, 70000';
    Bun.env.MACVIBES_PROXY_KEEPALIVE_MS = '2500';
    Bun.env.MACVIBES_ALLOW_HOST_AGENT = 'true';
    Bun.env.MACVIBES_AGENT_IDLE_TIMEOUT_MS = '60000';
    Bun.env.MACVIBES_AGENT_SLOW_COLD_START_TIMEOUT_MS = '900000';
    Bun.env.MACVIBES_AGENT_APPEND_PROMPT = 'Handle sofort.';
    Bun.env.MACVIBES_WEB_PORT = '5199';
    Bun.env.MACVIBES_ALLOWED_ORIGINS = ' https://mac.lan , , https://ipad.lan ';
    Bun.env.MACVIBES_DEBUG_ERRORS = '1';
    Bun.env.MACVIBES_RATE_LIMIT_DISABLED = '1';
    Bun.env.MACVIBES_FORCE_ADMIN = '1';
    const config = loadConfig();
    expect(config.egress.port).toBe(4011);
    // Ungültige Einträge werden gefiltert (gleiches Verhalten wie zuvor in
    // http/egressPolicy) — Tippfehler dürfen den Proxy nicht weit aufreißen.
    expect(config.egress.allowedPorts).toEqual([443, 8443]);
    expect(config.anthropic.keepAliveMs).toBe(2500);
    expect(config.agent.allowHostAgent).toBe(true);
    expect(config.agent.timeouts.idleMs).toBe(60000);
    expect(config.agent.timeouts.slowColdStartMs).toBe(900000);
    expect(config.agent.timeouts.firstEventMs).toBeUndefined();
    expect(config.agent.appendSystemPrompt).toBe('Handle sofort.');
    expect(config.devWebPort).toBe(5199);
    expect(config.allowedOrigins).toEqual(['https://mac.lan', 'https://ipad.lan']);
    expect(config.debugErrors).toBe(true);
    expect(config.rateLimitDisabled).toBe(true);
    expect(config.forceAdmin).toBe(true);
  });

  test('nur ungültige MACVIBES_EGRESS_PORTS fallen auf den Default zurück', () => {
    clearAll();
    Bun.env.MACVIBES_EGRESS_PORTS = 'unfug, -1';
    expect(loadConfig().egress.allowedPorts).toEqual([80, 443]);
  });

  /**
   * Abgleich mit scripts/lib/ports.ts (der bewussten Quelle der Repo-Skripte):
   * beide kennen dieselben Defaults getrennt — dieser Test verhindert, dass
   * sie driften. `web` (5173) hat bewusst KEIN Server-Pendant: der Default
   * lebt in apps/web/vite.config.ts, der Server kennt den Dev-Web-Port nur
   * bei ausdrücklich gesetztem MACVIBES_WEB_PORT (F5, s. index.ts).
   */
  test('Port-Defaults driften nicht gegen scripts/lib/ports.ts', () => {
    clearAll();
    const config = loadConfig();
    expect(config.port).toBe(PORT_DEFAULTS.server);
    expect(config.egress.port).toBe(PORT_DEFAULTS.egress);
    expect(config.sandbox.previewGatewayPort).toBe(PORT_DEFAULTS.gateway);
  });
});
