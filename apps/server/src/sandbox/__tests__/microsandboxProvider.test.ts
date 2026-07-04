import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  baselineExists,
  baselineSnapshotName,
  buildTemplateBaseline,
  removeSnapshot,
} from '../baselineService';
import {
  createTempDir,
  createTemplatesFixture,
  removeDir,
} from '../../services/__tests__/testUtils';
import { createProjectBranch, ensureBareRepo } from '../../services/gitService';
import { workspaceDirFor } from '../../services/workspaceService';
import { MicrosandboxSandboxProvider, msbAvailable } from '../microsandboxProvider';
import { runMsb } from '../msb';
import type { SandboxHandle } from '../provider';

const available = await msbAvailable();

const tempDirs: string[] = [];
let activeHandle: SandboxHandle | null = null;

afterEach(async () => {
  await activeHandle?.stop();
  activeHandle = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

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
    'startet devCommand in der VM, mappt den Preview-Port und stoppt sauber',
    async () => {
      const home = await createTempDir('macvibes-home-');
      tempDirs.push(home);
      const templates = await createTemplatesFixture();
      tempDirs.push(templates);
      const bare = join(home, 'macvibes-apps.git');
      await ensureBareRepo(bare);
      await createProjectBranch(bare, 'marco/vm-projekt', join(templates, 'pwa'));

      const provider = new MicrosandboxSandboxProvider({
        macvibesHome: home,
        bareRepoPath: bare,
        image: 'oven/bun',
        cpus: 1,
        memoryMib: 512,
      });

      const handle = await provider.start({
        projectId: 'vm-projekt',
        branchName: 'marco/vm-projekt',
        workspaceDir: workspaceDirFor(home, 'vm-projekt'),
        templateDir: 'pwa',
        devCommand: 'bun server.ts',
        previewPort: 5199,
      });
      activeHandle = handle;

      expect(handle.previewHostPort).not.toBeNull();
      const body = await waitForHttp(`http://localhost:${handle.previewHostPort}/`);
      expect(body).toBe('hallo-preview');

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
});

describe.skipIf(!available)('Watchdog in echter VM (R7, Crash-Recovery)', () => {
  test(
    'stirbt der Dev-Server in der VM, startet der Watchdog ihn neu — VM überlebt',
    async () => {
      const home = await createTempDir('macvibes-home-');
      tempDirs.push(home);
      const templates = await createTemplatesFixture();
      tempDirs.push(templates);
      const bare = join(home, 'macvibes-apps.git');
      await ensureBareRepo(bare);
      await createProjectBranch(bare, 'marco/wd', join(templates, 'pwa'));

      const provider = new MicrosandboxSandboxProvider({
        macvibesHome: home,
        bareRepoPath: bare,
        image: 'oven/bun',
        cpus: 1,
        memoryMib: 512,
      });
      const handle = await provider.start({
        projectId: 'wd',
        branchName: 'marco/wd',
        workspaceDir: workspaceDirFor(home, 'wd'),
        templateDir: 'pwa',
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

      // Dev-Server in der VM hart killen (die VM selbst bleibt: sleep infinity).
      // oven/bun hat kein pkill — portabel über /proc den server.ts-Prozess finden.
      // Eigene PID ausschließen — das Script selbst hat "server.ts" im cmdline.
      const killScript =
        'self=$$; for p in /proc/[0-9]*; do pid=${p#/proc/}; ' +
        '[ "$pid" = "$self" ] && continue; ' +
        'tr "\\0" " " < "$p/cmdline" 2>/dev/null | grep -q server.ts && kill "$pid"; ' +
        'done; true';
      await runMsb(['exec', 'macvibes-wd', '--', 'sh', '-c', killScript]);

      // Der Watchdog muss ihn neu starten → Preview wieder erreichbar UND eine
      // zusätzliche Startzeile (= echte neue Instanz, nicht bloß weitergelaufen).
      const start = Date.now();
      while (Date.now() - start < 40_000) {
        if (
          startCount() > before &&
          (await fetch(url)
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

describe.skipIf(!available)('Template-Baselines (B5b, Snapshot-Fork)', () => {
  test(
    'Projekt startet aus der Baseline: node_modules kommt als Symlink aus dem Snapshot',
    async () => {
      // ISOLIERTER Template-Name — NIE 'pwa'/'fullstack', sonst würde der Test
      // die Produktions-Baseline macvibes-tpl-pwa überschreiben (leeres node_modules).
      const templateDir = `bltest-${crypto.randomUUID().slice(0, 8)}`;
      const snapshotName = baselineSnapshotName(templateDir);

      const home = await createTempDir('macvibes-home-');
      tempDirs.push(home);
      const templates = await createTemplatesFixture(templateDir);
      tempDirs.push(templates);
      const bare = join(home, 'macvibes-apps.git');
      await ensureBareRepo(bare);
      await createProjectBranch(bare, 'marco/baseline-projekt', join(templates, templateDir));

      try {
        // Baseline für das isolierte Fixture-Template backen (bun install in der VM).
        await buildTemplateBaseline({ templatesDir: templates, templateDir, image: 'oven/bun' });
        expect(await baselineExists(templateDir)).toBe(true);

        const provider = new MicrosandboxSandboxProvider({
          macvibesHome: home,
          bareRepoPath: bare,
          image: 'oven/bun',
          cpus: 1,
          memoryMib: 512,
        });
        const workspaceDir = workspaceDirFor(home, 'baseline-projekt');
        const handle = await provider.start({
          projectId: 'baseline-projekt',
          branchName: 'marco/baseline-projekt',
          workspaceDir,
          templateDir,
          devCommand: 'bun server.ts',
          previewPort: 5199,
        });
        activeHandle = handle;

        const body = await waitForHttp(`http://localhost:${handle.previewHostPort}/`);
        expect(body).toBe('hallo-preview');

        // node_modules ist ein Symlink in den Snapshot — kein Install zur Laufzeit.
        const stat = lstatSync(join(workspaceDir, 'node_modules'), { throwIfNoEntry: false });
        expect(stat?.isSymbolicLink()).toBe(true);

        await handle.stop();
        activeHandle = null;
      } finally {
        await removeSnapshot(snapshotName);
      }
    },
    { timeout: 180_000 },
  );
});
