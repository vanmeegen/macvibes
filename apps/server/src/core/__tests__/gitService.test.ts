import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GitError,
  createProjectBranch,
  deleteBranch,
  ensureBareRepo,
  forkBranch,
  listBranches,
  runGit,
  runGitInRepo,
} from '../gitService';
import {
  createTempDir,
  createTemplatesFixture,
  removeDir,
} from '../../services/__tests__/testUtils';

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

describe('runGitInRepo — Härtung gegen gast-kontrollierte Arbeitsbäume (F1)', () => {
  test('ein präparierter Hook feuert NICHT (core.hooksPath neutralisiert, portabel)', async () => {
    const home = await createTempDir('macvibes-home-');
    tempDirs.push(home);
    const gitDir = join(home, 'git');
    const workTree = join(home, 'work');
    mkdirSync(workTree, { recursive: true });
    await runGit(['init', '-q', '--initial-branch=main', '--separate-git-dir', gitDir, workTree]);

    // Der „Agent" könnte Hooks nur über ein untergeschobenes gitDir setzen —
    // hier simuliert im echten gitDir: selbst DANN darf er nicht laufen.
    const hookDir = join(gitDir, 'hooks');
    mkdirSync(hookDir, { recursive: true });
    const hook = join(hookDir, 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho pwned > hook-lief.txt\n');
    chmodSync(hook, 0o755);

    await writeFile(join(workTree, 'datei.txt'), 'inhalt\n');
    const repo = { gitDir, workTree };
    await runGitInRepo(repo, ['add', '-A']);
    await runGitInRepo(repo, [
      '-c',
      'user.name=macvibes',
      '-c',
      'user.email=macvibes@local',
      'commit',
      '-q',
      '-m',
      'test',
    ]);

    // Commit ist durch, der Hook hat NICHT gefeuert.
    expect((await runGitInRepo(repo, ['rev-parse', 'HEAD'])).trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(workTree, 'hook-lief.txt'))).toBe(false);
  });

  test('Credential-Nachfragen scheitern schnell statt zu hängen (Askpass neutralisiert)', async () => {
    // 401-Server: git http würde hier interaktiv nach Credentials fragen.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response('auth nötig', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="test"' },
        }),
    });
    try {
      const home = await createTempDir('macvibes-home-');
      tempDirs.push(home);
      const gitDir = join(home, 'git');
      const workTree = join(home, 'work');
      mkdirSync(workTree, { recursive: true });
      await runGit(['init', '-q', '--initial-branch=main', '--separate-git-dir', gitDir, workTree]);

      const frist = Date.now() + 15_000;
      await expect(
        runGitInRepo({ gitDir, workTree }, [
          'fetch',
          `http://127.0.0.1:${server.port}/repo.git`,
          'main',
        ]),
      ).rejects.toThrow(GitError);
      // „schnell": deutlich unter einem interaktiven Hänger.
      expect(Date.now()).toBeLessThan(frist);
    } finally {
      server.stop(true);
    }
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
