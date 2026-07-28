import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectBranch, ensureBareRepo } from '../gitService';
import { bunCacheDirFor, ensureWorkspace, gitDirFor, workspaceDirFor } from '../workspaceService';
import { createTempDir, createTemplatesFixture, removeDir } from './testUtils';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

async function setup(): Promise<{ home: string; bare: string }> {
  const home = await createTempDir('macvibes-home-');
  tempDirs.push(home);
  const templates = await createTemplatesFixture();
  tempDirs.push(templates);
  const bare = join(home, 'macvibes-apps.git');
  await ensureBareRepo(bare);
  await createProjectBranch(bare, 'marco/dashboard', join(templates, 'pwa'));
  return { home, bare };
}

describe('bunCacheDirFor (persistenter Bun-Cache pro Projekt, ADR 0002)', () => {
  test('liegt im Projekt-Volume neben workspace und agent-config', () => {
    expect(bunCacheDirFor('/home/x/macvibes', 'p1')).toBe('/home/x/macvibes/volumes/p1/bun-cache');
  });
});

describe('ensureWorkspace (R9 Volume-Persistenz)', () => {
  test('klont den Projekt-Branch beim ersten Mal in das Projekt-Volume', async () => {
    const { home, bare } = await setup();
    const dir = await ensureWorkspace({
      macvibesHome: home,
      bareRepoPath: bare,
      projectId: 'projekt-1',
      branchName: 'marco/dashboard',
    });

    expect(dir).toBe(workspaceDirFor(home, 'projekt-1'));
    expect(existsSync(join(dir, 'index.html'))).toBe(true);
    // Die git-Metadaten liegen AUSSERHALB des Arbeitsbaums (F1) — der
    // Workspace wird read-write in die Sandbox gemountet, das gitDir nie.
    expect(existsSync(join(gitDirFor(home, 'projekt-1'), 'HEAD'))).toBe(true);
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });

  test('verwendet ein bestehendes Volume wieder, statt neu zu klonen', async () => {
    const { home, bare } = await setup();
    const params = {
      macvibesHome: home,
      bareRepoPath: bare,
      projectId: 'projekt-1',
      branchName: 'marco/dashboard',
    };
    const dir = await ensureWorkspace(params);
    await writeFile(join(dir, 'lokale-arbeit.txt'), 'nicht verlieren!');

    const again = await ensureWorkspace(params);
    expect(again).toBe(dir);
    expect(existsSync(join(dir, 'lokale-arbeit.txt'))).toBe(true);
  });
});

describe('ensureWorkspace — git-Metadaten außerhalb des Mounts (F1)', () => {
  const params = (home: string, bare: string) => ({
    macvibesHome: home,
    bareRepoPath: bare,
    projectId: 'projekt-1',
    branchName: 'marco/dashboard',
  });

  test('entfernt eine vom Gast nachträglich angelegte .git-Datei', async () => {
    const { home, bare } = await setup();
    const dir = await ensureWorkspace(params(home, bare));
    await writeFile(join(dir, '.git'), 'gitdir: /tmp/boese\n');

    await ensureWorkspace(params(home, bare));

    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(gitDirFor(home, 'projekt-1'), 'HEAD'))).toBe(true);
  });
});
