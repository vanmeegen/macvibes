import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createProjectBranch, ensureBareRepo, listBranches } from '../gitService';
import { mirrorToGitHub, startMirrorScheduler } from '../mirrorService';
import { createTempDir, createTemplatesFixture, removeDir } from './testUtils';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

function silentLogger() {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    errors,
    logger: { info: (m: string) => infos.push(m), error: (m: string) => errors.push(m) },
  };
}

async function setupSource(): Promise<string> {
  const home = await createTempDir('macvibes-src-');
  tempDirs.push(home);
  const templates = await createTemplatesFixture();
  tempDirs.push(templates);
  const bare = join(home, 'macvibes-apps.git');
  await ensureBareRepo(bare);
  await createProjectBranch(bare, 'marco/dashboard', join(templates, 'pwa'));
  return bare;
}

describe('mirrorToGitHub', () => {
  test('deaktiviert ohne Remote → skipped', async () => {
    const result = await mirrorToGitHub({ bareRepoPath: '/egal', remoteUrl: null });
    expect(result).toBe('skipped');
  });

  test('spiegelt alle Branches in ein leeres Remote (lokales Bare-Repo als GitHub-Ersatz)', async () => {
    const bare = await setupSource();
    // "GitHub" simulieren: ein zweites lokales Bare-Repo als Remote-URL.
    const remote = join(await createTempDir('macvibes-remote-'), 'mirror.git');
    tempDirs.push(remote);
    await ensureBareRepo(remote);

    const { logger } = silentLogger();
    const result = await mirrorToGitHub({ bareRepoPath: bare, remoteUrl: remote }, logger);

    expect(result).toBe('pushed');
    expect(await listBranches(remote)).toContain('marco/dashboard');
  });

  test('überträgt auch neue Branches beim erneuten Spiegeln', async () => {
    const bare = await setupSource();
    const remote = join(await createTempDir('macvibes-remote-'), 'mirror.git');
    tempDirs.push(remote);
    await ensureBareRepo(remote);
    const templates = await createTemplatesFixture();
    tempDirs.push(templates);

    await mirrorToGitHub({ bareRepoPath: bare, remoteUrl: remote });
    await createProjectBranch(bare, 'gast/tool', join(templates, 'pwa'));
    const result = await mirrorToGitHub({ bareRepoPath: bare, remoteUrl: remote });

    expect(result).toBe('pushed');
    expect((await listBranches(remote)).sort()).toEqual(['gast/tool', 'marco/dashboard']);
  });

  test('fehlerhaftes Remote → error, ohne zu werfen', async () => {
    const bare = await setupSource();
    const { errors, logger } = silentLogger();
    const result = await mirrorToGitHub(
      { bareRepoPath: bare, remoteUrl: '/existiert/nicht/remote.git' },
      logger,
    );
    expect(result).toBe('error');
    expect(errors.length).toBe(1);
  });
});

describe('startMirrorScheduler', () => {
  test('ohne Remote ist der Scheduler ein No-op', async () => {
    const scheduler = startMirrorScheduler({ bareRepoPath: '/egal', remoteUrl: null }, 10);
    expect(await scheduler.runOnce()).toBe('skipped');
    scheduler.stop();
  });

  test('runOnce spiegelt einmalig', async () => {
    const bare = await setupSource();
    const remote = join(await createTempDir('macvibes-remote-'), 'mirror.git');
    tempDirs.push(remote);
    await ensureBareRepo(remote);

    const scheduler = startMirrorScheduler({ bareRepoPath: bare, remoteUrl: remote }, 3600_000);
    const result = await scheduler.runOnce();
    scheduler.stop();

    expect(result).toBe('pushed');
    expect(await listBranches(remote)).toContain('marco/dashboard');
  });
});
