import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { DomainError } from '../errors';
import { ensureBareRepo, listBranches } from '../gitService';
import { createProject, deleteProject, getProject, listProjects } from '../projectsService';
import {
  createTempDir,
  createTemplatesFixture,
  createTestDb,
  createUser,
  removeDir,
} from './testUtils';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

async function setup() {
  const db = createTestDb();
  const home = await createTempDir('macvibes-home-');
  tempDirs.push(home);
  const templatesDir = await createTemplatesFixture();
  tempDirs.push(templatesDir);
  const config = { bareRepoPath: join(home, 'macvibes-apps.git'), templatesDir };
  await ensureBareRepo(config.bareRepoPath);
  const marco = await createUser(db, 'marco');
  return { db, config, marco };
}

describe('createProject', () => {
  test('legt Branch und DB-Eintrag an', async () => {
    const { db, config, marco } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Mein Dashboard!',
      templateDir: 'pwa',
    });

    expect(project.branchName).toBe('marco/mein-dashboard');
    expect(project.owner.username).toBe('marco');
    expect(project.devCommand).toBe('bun run dev');
    expect(await listBranches(config.bareRepoPath)).toEqual(['marco/mein-dashboard']);
    expect(await listProjects(db)).toHaveLength(1);
  });

  test('lehnt doppelten Namen desselben Users ab', async () => {
    const { db, config, marco } = await setup();
    await createProject(db, config, marco, { name: 'Dashboard', templateDir: 'pwa' });
    await expect(
      createProject(db, config, marco, { name: 'Dashboard', templateDir: 'pwa' }),
    ).rejects.toThrow('bereits ein Projekt');
    expect(await listBranches(config.bareRepoPath)).toHaveLength(1);
  });

  test('erlaubt gleichen Namen bei verschiedenen Usern (Branch-Prefix)', async () => {
    const { db, config, marco } = await setup();
    const gast = await createUser(db, 'gast');
    await createProject(db, config, marco, { name: 'Dashboard', templateDir: 'pwa' });
    const second = await createProject(db, config, gast, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    expect(second.branchName).toBe('gast/dashboard');
    expect((await listBranches(config.bareRepoPath)).sort()).toEqual([
      'gast/dashboard',
      'marco/dashboard',
    ]);
  });

  test('löst Slug-Kollisionen mit Suffix auf', async () => {
    const { db, config, marco } = await setup();
    await createProject(db, config, marco, { name: 'Foo!', templateDir: 'pwa' });
    const second = await createProject(db, config, marco, { name: 'Foo?', templateDir: 'pwa' });
    expect(second.branchName).toBe('marco/foo-2');
  });

  test('lehnt unbekanntes Template ab', async () => {
    const { db, config, marco } = await setup();
    await expect(
      createProject(db, config, marco, { name: 'X-Projekt', templateDir: 'nope' }),
    ).rejects.toThrow('Unbekanntes Template');
    expect(await listBranches(config.bareRepoPath)).toHaveLength(0);
  });

  test('lehnt Namen ohne verwertbare Zeichen ab', async () => {
    const { db, config, marco } = await setup();
    await expect(
      createProject(db, config, marco, { name: '!!!', templateDir: 'pwa' }),
    ).rejects.toThrow(DomainError);
  });
});

describe('deleteProject', () => {
  test('löscht nur den DB-Eintrag, der Branch bleibt', async () => {
    const { db, config, marco } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    await deleteProject(db, marco, project.id);
    expect(await listProjects(db)).toHaveLength(0);
    expect(await listBranches(config.bareRepoPath)).toEqual(['marco/dashboard']);
    expect(await getProject(db, project.id)).toBeNull();
  });

  test('verweigert Löschen für fremde Projekte', async () => {
    const { db, config, marco } = await setup();
    const gast = await createUser(db, 'gast');
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    await expect(deleteProject(db, gast, project.id)).rejects.toThrow('Nur der Eigentümer');
    expect(await listProjects(db)).toHaveLength(1);
  });
});
