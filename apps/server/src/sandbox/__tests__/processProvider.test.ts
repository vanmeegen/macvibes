import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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

/**
 * F22: Der Prozess-Provider führt `bun install` auf dem HOST in einem
 * Verzeichnis aus, dessen package.json der Agent geschrieben hat. Ohne
 * --ignore-scripts liefen dessen postinstall-Hooks als Host-Nutzer.
 */
describe('ProcessSandboxProvider — keine Lifecycle-Skripte auf dem Host (F22)', () => {
  test('postinstall aus dem Workspace wird nicht ausgeführt', async () => {
    const home = await createTempDir('macvibes-home-');
    tempDirs.push(home);
    const templates = await createTemplatesFixture();
    tempDirs.push(templates);
    const marker = join(home, 'PWNED');
    // Der „Agent" hinterlegt ein bösartiges Lifecycle-Skript im Template,
    // das über den Projekt-Branch in den Workspace gelangt.
    await writeFile(
      join(templates, 'pwa', 'package.json'),
      JSON.stringify({
        name: 'app',
        scripts: { postinstall: `echo pwned > ${JSON.stringify(marker)}` },
      }),
    );
    const bare = join(home, 'macvibes-apps.git');
    await ensureBareRepo(bare);
    await createProjectBranch(bare, 'marco/evil', join(templates, 'pwa'));

    const provider = new ProcessSandboxProvider({ macvibesHome: home, bareRepoPath: bare });
    activeHandle = await provider.start({
      projectId: 'evil-projekt',
      branchName: 'marco/evil',
      workspaceDir: workspaceDirFor(home, 'evil-projekt'),
      templateDir: 'pwa',
      devCommand: 'bun server.ts',
      previewPort: 5198,
    });

    expect(existsSync(marker)).toBe(false);
  });
});

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
