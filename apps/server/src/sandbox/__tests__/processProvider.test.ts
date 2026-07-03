import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createTempDir,
  createTemplatesFixture,
  removeDir,
} from '../../services/__tests__/testUtils';
import { createProjectBranch, ensureBareRepo } from '../../services/gitService';
import { workspaceDirFor } from '../../services/workspaceService';
import { ProcessSandboxProvider } from '../processProvider';
import type { SandboxHandle } from '../provider';

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

async function waitForHttp(url: string, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
    } catch {
      // Server noch nicht bereit — weiter pollen.
    }
    await Bun.sleep(50);
  }
  throw new Error(`Preview unter ${url} wurde nicht erreichbar`);
}

describe('ProcessSandboxProvider Preview (R7)', () => {
  test('startet das devCommand mit PORT-Env und liefert den Host-Port', async () => {
    const home = await createTempDir('macvibes-home-');
    tempDirs.push(home);
    const templates = await createTemplatesFixture();
    tempDirs.push(templates);
    const bare = join(home, 'macvibes-apps.git');
    await ensureBareRepo(bare);
    await createProjectBranch(bare, 'marco/preview', join(templates, 'pwa'));

    const provider = new ProcessSandboxProvider({ macvibesHome: home, bareRepoPath: bare });
    const handle = await provider.start({
      projectId: 'preview-projekt',
      branchName: 'marco/preview',
      workspaceDir: workspaceDirFor(home, 'preview-projekt'),
      devCommand: 'bun server.ts',
      previewPort: 5199,
    });
    activeHandle = handle;

    expect(handle.previewHostPort).not.toBeNull();
    const body = await waitForHttp(`http://localhost:${handle.previewHostPort}/`);
    expect(body).toBe('hallo-preview');

    await handle.stop();
    activeHandle = null;
    // Nach dem Stopp ist der Dev-Server nicht mehr erreichbar.
    await Bun.sleep(150);
    let reachable = true;
    try {
      await fetch(`http://localhost:${handle.previewHostPort}/`);
    } catch {
      reachable = false;
    }
    expect(reachable).toBe(false);
  });
});
