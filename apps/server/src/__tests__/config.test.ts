import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveDbPath } from '../config';
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
    // In einem Verzeichnis OHNE ./data/app.db — sonst greift zu Recht der
    // Bestandsschutz (der Testlauf selbst hat eine Alt-DB neben sich).
    const cwd = process.cwd();
    const leer = await createTempDir('macvibes-leer-');
    tempDirs.push(leer);
    process.chdir(leer);
    try {
      const path = resolveDbPath(home);
      expect(path).toBe(join(home, 'data', 'app.db'));
      expect(path.startsWith('./')).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  test('eine bestehende DB unter ./data wird weiter benutzt (Bestandsschutz)', async () => {
    delete Bun.env.DB_PATH;
    delete Bun.env.MACVIBES_TEST_MODE;
    const cwd = process.cwd();
    const sandbox = await createTempDir('macvibes-cwd-');
    tempDirs.push(sandbox);
    mkdirSync(join(sandbox, 'data'), { recursive: true });
    writeFileSync(join(sandbox, 'data', 'app.db'), '');
    process.chdir(sandbox);
    try {
      expect(resolveDbPath('/anderer/home')).toBe('./data/app.db');
    } finally {
      process.chdir(cwd);
    }
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
