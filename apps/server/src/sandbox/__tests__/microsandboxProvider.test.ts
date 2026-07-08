import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDaemonBundle } from '../../agent/daemonBundle';
import { baselineExists, buildTemplateBaseline } from '../baselineService';
import {
  createTempDir,
  createTemplatesFixture,
  removeDir,
} from '../../services/__tests__/testUtils';
import { createProjectBranch, ensureBareRepo } from '../../services/gitService';
import { workspaceDirFor } from '../../services/workspaceService';
import {
  AGENT_CONFIG_GUEST_DIR,
  MicrosandboxSandboxProvider,
  msbAvailable,
} from '../microsandboxProvider';
import { runMsb } from '../msb';
import type { SandboxHandle } from '../provider';
import type { MicrosandboxProviderConfig } from '../microsandboxProvider';

const available = await msbAvailable();

/**
 * Stabiler Fixture-Template-Name → Snapshot `macvibes-tpl-msbtest-v2` bleibt
 * zwischen Testläufen bestehen (apt/SDK-Install nur beim ersten Lauf, CI
 * bleibt schnell). Die VERSION HOCHZÄHLEN, wenn sich das Fixture ändert
 * (createTemplatesFixture, z. B. server.ts) — sonst testet der Lauf den alten
 * Snapshot-Stand.
 */
const FIXTURE_TEMPLATE_DIR = 'msbtest-v2';

const tempDirs: string[] = [];
let activeHandle: SandboxHandle | null = null;
let bundleDir = '';

beforeAll(async () => {
  if (!available) return;
  bundleDir = await createTempDir('macvibes-bundle-');
  await buildDaemonBundle(bundleDir);
  if (!(await baselineExists(FIXTURE_TEMPLATE_DIR))) {
    const templates = await createTemplatesFixture(FIXTURE_TEMPLATE_DIR);
    try {
      // Mit Daemon-Zubehör (tini/monit/SDK): der Provider setzt es voraus.
      // Dauert Minuten (apt + bun add) — daher der großzügige Hook-Timeout.
      await buildTemplateBaseline({
        templatesDir: templates,
        templateDir: FIXTURE_TEMPLATE_DIR,
        image: 'oven/bun',
      });
    } finally {
      await removeDir(templates);
    }
  }
}, 900_000);

afterEach(async () => {
  await activeHandle?.stop();
  activeHandle = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
}, 60_000);

afterAll(async () => {
  if (bundleDir.length > 0) await removeDir(bundleDir);
});

/** Provider-Konfiguration mit totem Gateway — der Daemon idlet nur (Reconnects). */
function providerConfig(home: string, bare: string): MicrosandboxProviderConfig {
  return {
    macvibesHome: home,
    bareRepoPath: bare,
    image: 'oven/bun',
    cpus: 1,
    memoryMib: 512,
    agentDaemon: {
      bundleDir,
      envFor: (sandboxName) => ({
        MACVIBES_AGENT_GATEWAY_URL: `ws://host.microsandbox.internal:9/agent?sandbox=${sandboxName}&token=test`,
        MACVIBES_AGENT_CWD: '/work',
      }),
    },
  };
}

async function projectSetup(projectId: string): Promise<{ home: string; bare: string }> {
  const home = await createTempDir('macvibes-home-');
  tempDirs.push(home);
  const templates = await createTemplatesFixture(FIXTURE_TEMPLATE_DIR);
  tempDirs.push(templates);
  const bare = join(home, 'macvibes-apps.git');
  await ensureBareRepo(bare);
  await createProjectBranch(bare, `marco/${projectId}`, join(templates, FIXTURE_TEMPLATE_DIR));
  return { home, bare };
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.text();
    } catch {
      // VM bootet noch — weiter pollen.
    }
    await Bun.sleep(300);
  }
  throw new Error(`Preview unter ${url} wurde nicht erreichbar`);
}

describe.skipIf(!available)('MicrosandboxSandboxProvider (R7/R9, echte MicroVM)', () => {
  test(
    'startet devCommand unter monit, mappt den Preview-Port und stoppt sauber',
    async () => {
      const { home, bare } = await projectSetup('vm-projekt');
      const provider = new MicrosandboxSandboxProvider(providerConfig(home, bare));

      const workspaceDir = workspaceDirFor(home, 'vm-projekt');
      const handle = await provider.start({
        projectId: 'vm-projekt',
        branchName: 'marco/vm-projekt',
        workspaceDir,
        templateDir: FIXTURE_TEMPLATE_DIR,
        devCommand: 'bun server.ts',
        previewPort: 5199,
      });
      activeHandle = handle;

      expect(handle.previewHostPort).not.toBeNull();
      const body = await waitForHttp(`http://localhost:${handle.previewHostPort}/`);
      expect(body).toBe('hallo-preview');

      // node_modules ist ein Symlink in den Snapshot — kein Install zur Laufzeit (B5b).
      const stat = lstatSync(join(workspaceDir, 'node_modules'), { throwIfNoEntry: false });
      expect(stat?.isSymbolicLink()).toBe(true);

      // Host-Gateway (Credential-Proxy-Pfad, B5c): die VM erreicht den Host
      // über host.microsandbox.internal — die net-rule des Providers muss das erlauben.
      const hostServer = Bun.serve({
        port: 0,
        hostname: '0.0.0.0',
        fetch: () => new Response('host-erreicht'),
      });
      try {
        const gatewayProbe = Bun.spawn(
          [
            'msb',
            'exec',
            'macvibes-vm-projekt',
            '--',
            'bun',
            '-e',
            `const r = await fetch('http://host.microsandbox.internal:${hostServer.port}/', { signal: AbortSignal.timeout(5000) }); console.log(await r.text());`,
          ],
          { stdout: 'pipe', stderr: 'ignore' },
        );
        const gatewayOut = await new Response(gatewayProbe.stdout).text();
        expect(await gatewayProbe.exited).toBe(0);
        expect(gatewayOut).toContain('host-erreicht');
      } finally {
        hostServer.stop(true);
      }

      await handle.stop();
      activeHandle = null;
      await Bun.sleep(500);
      let reachable = true;
      try {
        await fetch(`http://localhost:${handle.previewHostPort}/`, {
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        reachable = false;
      }
      expect(reachable).toBe(false);
    },
    { timeout: 120_000 },
  );

  test('ohne Baseline-Snapshot scheitert der Start mit klarer Anweisung', async () => {
    const { home, bare } = await projectSetup('ohne-baseline');
    const provider = new MicrosandboxSandboxProvider(providerConfig(home, bare));
    expect(
      provider.start({
        projectId: 'ohne-baseline',
        branchName: 'marco/ohne-baseline',
        workspaceDir: workspaceDirFor(home, 'ohne-baseline'),
        templateDir: `fehlt-${crypto.randomUUID().slice(0, 8)}`,
        devCommand: 'bun server.ts',
        previewPort: 5199,
      }),
    ).rejects.toThrow(/Baseline/);
  });
});

describe.skipIf(!available)('Agent-Config-Persistenz (R9, resume über VM-Neustart)', () => {
  test(
    'CLAUDE_CONFIG_DIR liegt auf einem Volume, das einen VM-Neustart übersteht',
    async () => {
      const { home, bare } = await projectSetup('cfg');
      const provider = new MicrosandboxSandboxProvider(providerConfig(home, bare));
      const ctx = {
        projectId: 'cfg',
        branchName: 'marco/cfg',
        workspaceDir: workspaceDirFor(home, 'cfg'),
        templateDir: FIXTURE_TEMPLATE_DIR,
        devCommand: 'bun server.ts',
        previewPort: 5199,
      };

      // 1. Start: Marker in die Agent-Config schreiben (simuliert eine Session-Datei).
      const h1 = await provider.start(ctx);
      activeHandle = h1;
      await runMsb([
        'exec',
        'macvibes-cfg',
        '--',
        'sh',
        '-c',
        `echo sess-123 > ${AGENT_CONFIG_GUEST_DIR}/session-marker`,
      ]);
      await h1.stop();
      activeHandle = null;

      // 2. Neustart: frische VM (Fork aus Baseline) — der Marker muss noch da sein.
      const h2 = await provider.start(ctx);
      activeHandle = h2;
      const marker = await runMsb([
        'exec',
        'macvibes-cfg',
        '--',
        'sh',
        '-c',
        `cat ${AGENT_CONFIG_GUEST_DIR}/session-marker 2>/dev/null || echo FEHLT`,
      ]);
      expect(marker.trim()).toBe('sess-123');

      await h2.stop();
      activeHandle = null;
    },
    { timeout: 180_000 },
  );
});

describe.skipIf(!available)('In-VM-Supervision (R7, Crash-Recovery durch monit)', () => {
  test(
    'stirbt der Dev-Server in der VM, startet monit ihn neu — VM überlebt',
    async () => {
      const { home, bare } = await projectSetup('wd');
      const provider = new MicrosandboxSandboxProvider(providerConfig(home, bare));
      const handle = await provider.start({
        projectId: 'wd',
        branchName: 'marco/wd',
        workspaceDir: workspaceDirFor(home, 'wd'),
        templateDir: FIXTURE_TEMPLATE_DIR,
        devCommand: 'bun server.ts',
        previewPort: 5199,
      });
      activeHandle = handle;
      const url = `http://localhost:${handle.previewHostPort}/`;
      const startsFile = join(workspaceDirFor(home, 'wd'), '.starts');
      const startCount = () =>
        existsSync(startsFile) ? readFileSync(startsFile, 'utf8').trim().split('\n').length : 0;

      // Erstmal läuft die Preview (genau ein Start).
      expect(await waitForHttp(url)).toBe('hallo-preview');
      const before = startCount();
      expect(before).toBe(1);

      // Dev-Server von INNEN crashen (/crash → process.exit(1)): eine
      // msb-exec-Session kann Prozesse im PID-1-Baum nicht killen
      // (eigene PID-Namespaces, Spike-Befund 2026-07-06).
      const crashResponse = await fetch(`${url}crash`, { signal: AbortSignal.timeout(3000) });
      expect(await crashResponse.text()).toBe('crash');

      // monit muss ihn neu starten → Preview wieder erreichbar UND eine
      // zusätzliche Startzeile (= echte neue Instanz, nicht bloß weitergelaufen).
      const start = Date.now();
      while (Date.now() - start < 40_000) {
        if (
          startCount() > before &&
          (await fetch(url, { signal: AbortSignal.timeout(1500) })
            .then((r) => r.ok)
            .catch(() => false))
        )
          break;
        await Bun.sleep(300);
      }
      expect(startCount()).toBeGreaterThan(before);
      expect(await waitForHttp(url, 10_000)).toBe('hallo-preview');

      // Und die VM lebt weiter (msb exec funktioniert = Agent-Umgebung intakt).
      const alive = await runMsb(['exec', 'macvibes-wd', '--', 'echo', 'vm-lebt']);
      expect(alive).toContain('vm-lebt');

      await handle.stop();
      activeHandle = null;
    },
    { timeout: 120_000 },
  );
});

describe('msbAvailable', () => {
  test('erkennt die installierte msb-CLI', async () => {
    // Auf diesem Entwicklungsrechner ist msb installiert (B5-Voraussetzung).
    expect(await msbAvailable()).toBe(true);
  });
});
