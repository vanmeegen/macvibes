import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { baselineExists, buildTemplateBaseline } from '../baselineService';
import {
  createTempDir,
  createTemplatesFixture,
  removeDir,
} from '../../services/__tests__/testUtils';
import { createProjectBranch, ensureBareRepo } from '../../services/gitService';
import { workspaceDirFor } from '../../services/workspaceService';
import { MicrosandboxSandboxProvider, msbAvailable } from '../microsandboxProvider';
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
      const home = await createTempDir('macvibes-home-');
      tempDirs.push(home);
      const templates = await createTemplatesFixture();
      tempDirs.push(templates);
      const bare = join(home, 'macvibes-apps.git');
      await ensureBareRepo(bare);
      await createProjectBranch(bare, 'marco/baseline-projekt', join(templates, 'pwa'));

      // Baseline für das Fixture-Template backen (bun install in der VM).
      await buildTemplateBaseline({
        templatesDir: templates,
        templateDir: 'pwa',
        image: 'oven/bun',
      });
      expect(await baselineExists('pwa')).toBe(true);

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
        templateDir: 'pwa',
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
    },
    { timeout: 180_000 },
  );
});
