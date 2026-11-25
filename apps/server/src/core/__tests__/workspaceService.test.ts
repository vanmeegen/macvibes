import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectBranch, ensureBareRepo, runGit } from '../gitService';
import { bunCacheDirFor, ensureWorkspace, gitDirFor, workspaceDirFor } from '../workspaceService';
import { createTempDir, createTemplatesFixture, trackTempDirs } from '../../testing/testUtils';

const tempDirs = trackTempDirs();

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
    // join statt String-Literal: der Host-Pfad-Trenner ist plattformabhängig.
    expect(bunCacheDirFor('/home/x/macvibes', 'p1')).toBe(
      join('/home/x/macvibes', 'volumes', 'p1', 'bun-cache'),
    );
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

/**
 * Der Klon aus dem lokalen Bare-Repo darf NICHT dessen Objektordner Datei für
 * Datei kopieren (gits Abkürzung für lokale Pfade): schreibt währenddessen ein
 * anderes Projekt ins Bare-Repo (Auto-Commit, Projekt anlegen), bricht der Klon
 * mit „failed to copy file … No such file or directory" ab — in der Live-Suite
 * getroffen, per Dauerschleife nachgestellt (2 von 120 Klonen, mit --no-local
 * 0 von 120). Über den regulären Transport kommt nur der eigene Branch an;
 * genau das ist hier beobachtbar.
 */
describe('ensureWorkspace — Klon über den regulären Transport', () => {
  test('das gitDir enthält nur die Objekte des eigenen Branches', async () => {
    const { home, bare } = await setup();
    const fremd = await createTemplatesFixture();
    tempDirs.push(fremd);
    await writeFile(
      join(fremd, 'pwa', 'nur-im-fremden-projekt.txt'),
      'gehört einem anderen Projekt',
    );
    await createProjectBranch(bare, 'anna/geheim', join(fremd, 'pwa'));
    const fremderCommit = (await runGit(['rev-parse', 'refs/heads/anna/geheim'], bare)).trim();

    await ensureWorkspace({
      macvibesHome: home,
      bareRepoPath: bare,
      projectId: 'projekt-1',
      branchName: 'marco/dashboard',
    });

    const gitDir = gitDirFor(home, 'projekt-1');
    const eigenerCommit = (await runGit(['--git-dir', gitDir, 'rev-parse', 'HEAD'])).trim();
    expect(eigenerCommit).not.toBe(fremderCommit);
    // `cat-file -e` endet mit Fehler, wenn das Objekt fehlt.
    await expect(runGit(['--git-dir', gitDir, 'cat-file', '-e', fremderCommit])).rejects.toThrow();
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
