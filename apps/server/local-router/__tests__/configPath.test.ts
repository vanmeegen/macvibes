import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { resolveRouterConfigPath } from '../configPath';

const home = '/home/tester/macvibes';
const bundledDir = '/repo/apps/server/local-router';
const bundled = join(bundledDir, 'litellm_config.yaml');
const homeConfig = join(home, 'litellm.yaml');

describe('resolveRouterConfigPath (Env > <macvibesHome>/litellm.yaml > mitgeliefert)', () => {
  test('MACVIBES_LOCAL_ROUTER_CONFIG gewinnt immer — auch wenn die Home-Datei existiert', () => {
    const result = resolveRouterConfigPath({
      envPath: '/etc/custom/litellm.yaml',
      macvibesHome: home,
      bundledDir,
      exists: () => true,
    });
    expect(result).toBe('/etc/custom/litellm.yaml');
  });

  test('ohne Env: existierende <macvibesHome>/litellm.yaml wird genommen', () => {
    const result = resolveRouterConfigPath({
      envPath: undefined,
      macvibesHome: home,
      bundledDir,
      exists: (p) => p === homeConfig,
    });
    expect(result).toBe(homeConfig);
  });

  test('ohne Env und ohne Home-Datei: die mitgelieferte Config (Rückwärtskompatibilität)', () => {
    const result = resolveRouterConfigPath({
      envPath: undefined,
      macvibesHome: home,
      bundledDir,
      exists: () => false,
    });
    expect(result).toBe(bundled);
  });

  test('leere Env-Variable zählt als nicht gesetzt', () => {
    const result = resolveRouterConfigPath({
      envPath: '',
      macvibesHome: home,
      bundledDir,
      exists: () => false,
    });
    expect(result).toBe(bundled);
  });
});
