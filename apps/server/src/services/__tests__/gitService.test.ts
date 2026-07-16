import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  GitError,
  createProjectBranch,
  deleteBranch,
  ensureBareRepo,
  forkBranch,
  listBranches,
} from '../gitService';
import { createTempDir, createTemplatesFixture, removeDir } from './testUtils';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

async function setup(): Promise<{ bare: string; templatePath: string }> {
  const home = await createTempDir('macvibes-home-');
  tempDirs.push(home);
  const templates = await createTemplatesFixture();
  tempDirs.push(templates);
  const bare = join(home, 'macvibes-apps.git');
  await ensureBareRepo(bare);
  return { bare, templatePath: join(templates, 'pwa') };
}

describe('ensureBareRepo', () => {
  test('legt Bare-Repo an und ist idempotent', async () => {
    const { bare } = await setup();
    await ensureBareRepo(bare);
    expect(await listBranches(bare)).toHaveLength(0);
  });
});

describe('createProjectBranch', () => {
  test('erzeugt Orphan-Branch mit Template-Inhalt', async () => {
    const { bare, templatePath } = await setup();
    await createProjectBranch(bare, 'marco/dashboard', templatePath);

    expect(await listBranches(bare)).toEqual(['marco/dashboard']);

    const proc = Bun.spawn(['git', 'show', 'marco/dashboard:index.html'], {
      cwd: bare,
      stdout: 'pipe',
    });
    const content = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(content).toContain('PWA');
  });

  test('schlägt fehl, wenn der Branch schon existiert', async () => {
    const { bare, templatePath } = await setup();
    await createProjectBranch(bare, 'marco/dashboard', templatePath);
    await expect(createProjectBranch(bare, 'marco/dashboard', templatePath)).rejects.toThrow(
      GitError,
    );
  });
});

describe('forkBranch („Kopieren und Anpassen")', () => {
  test('neuer Branch zeigt auf den HEAD des Quell-Branches (voller Stand, volle Historie)', async () => {
    const { bare, templatePath } = await setup();
    await createProjectBranch(bare, 'marco/dashboard', templatePath);

    await forkBranch(bare, 'gast/dashboard-kopie', 'marco/dashboard');

    expect((await listBranches(bare)).sort()).toEqual(['gast/dashboard-kopie', 'marco/dashboard']);
    const proc = Bun.spawn(['git', 'rev-parse', 'marco/dashboard', 'gast/dashboard-kopie'], {
      cwd: bare,
      stdout: 'pipe',
    });
    const [a, b] = (await new Response(proc.stdout).text()).trim().split('\n');
    expect(a).toBe(b);
  });

  test('schlägt fehl, wenn der Quell-Branch fehlt oder das Ziel existiert', async () => {
    const { bare, templatePath } = await setup();
    await createProjectBranch(bare, 'marco/dashboard', templatePath);
    await expect(forkBranch(bare, 'gast/kopie', 'marco/fehlt')).rejects.toThrow(GitError);
    await expect(forkBranch(bare, 'marco/dashboard', 'marco/dashboard')).rejects.toThrow(GitError);
  });
});

describe('deleteBranch', () => {
  test('entfernt den Branch aus dem Bare-Repo', async () => {
    const { bare, templatePath } = await setup();
    await createProjectBranch(bare, 'marco/dashboard', templatePath);
    await deleteBranch(bare, 'marco/dashboard');
    expect(await listBranches(bare)).toHaveLength(0);
  });
});
