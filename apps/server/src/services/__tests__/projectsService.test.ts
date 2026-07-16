import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../errors';
import { ensureBareRepo, listBranches } from '../gitService';
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
} from '../projectsService';
import { projectVolumeDir } from '../workspaceService';
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
  return { db, config, marco, home };
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

describe('renameProject', () => {
  test('ändert den Anzeigenamen, der Git-Branch bleibt stabil', async () => {
    const { db, config, marco } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });

    const renamed = await renameProject(db, marco, project.id, 'Cockpit');

    expect(renamed.name).toBe('Cockpit');
    expect(renamed.branchName).toBe('marco/dashboard');
    const reloaded = await getProject(db, project.id);
    expect(reloaded?.name).toBe('Cockpit');
    expect(reloaded?.branchName).toBe('marco/dashboard');
    expect(await listBranches(config.bareRepoPath)).toEqual(['marco/dashboard']);
  });

  test('verweigert Umbenennen für fremde Projekte (Nicht-Admin)', async () => {
    const { db, config, marco } = await setup();
    const gast = await createUser(db, 'gast');
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    await expect(renameProject(db, gast, project.id, 'Meins')).rejects.toThrow(
      'Nur der Eigentümer',
    );
    expect((await getProject(db, project.id))?.name).toBe('Dashboard');
  });

  test('erlaubt Admins das Umbenennen fremder Projekte', async () => {
    // marco ist als erster User Admin; gast ist ein normaler User.
    const { db, config, marco } = await setup();
    const gast = await createUser(db, 'gast');
    const project = await createProject(db, config, gast, {
      name: 'Gast-Projekt',
      templateDir: 'pwa',
    });

    const renamed = await renameProject(db, marco, project.id, 'Vom Admin umbenannt');

    expect(renamed.name).toBe('Vom Admin umbenannt');
    expect(renamed.owner.username).toBe('gast');
  });

  test('prüft Duplikate beim Admin-Rename im Namensraum des Eigentümers', async () => {
    const { db, config, marco } = await setup();
    const gast = await createUser(db, 'gast');
    await createProject(db, config, gast, { name: 'Bestand', templateDir: 'pwa' });
    const second = await createProject(db, config, gast, { name: 'Anderes', templateDir: 'pwa' });
    // marco (Admin) hat selbst ein Projekt „Bestand" — das darf NICHT stören …
    await createProject(db, config, marco, { name: 'Bestand', templateDir: 'pwa' });

    // … aber gasts eigenes „Bestand" kollidiert.
    await expect(renameProject(db, marco, second.id, 'Bestand')).rejects.toThrow(
      'bereits ein Projekt',
    );
  });

  test('lehnt doppelten Namen desselben Users ab', async () => {
    const { db, config, marco } = await setup();
    await createProject(db, config, marco, { name: 'Dashboard', templateDir: 'pwa' });
    const second = await createProject(db, config, marco, { name: 'Notizen', templateDir: 'pwa' });
    await expect(renameProject(db, marco, second.id, 'Dashboard')).rejects.toThrow(
      'bereits ein Projekt',
    );
  });

  test('erlaubt das erneute Speichern des unveränderten Namens', async () => {
    const { db, config, marco } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    const renamed = await renameProject(db, marco, project.id, 'Dashboard');
    expect(renamed.name).toBe('Dashboard');
  });

  test('lehnt ungültige Namen ab', async () => {
    const { db, config, marco } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    await expect(renameProject(db, marco, project.id, '   ')).rejects.toThrow();
    expect((await getProject(db, project.id))?.name).toBe('Dashboard');
  });

  test('meldet unbekannte Projekte als Fehler', async () => {
    const { db, marco } = await setup();
    await expect(renameProject(db, marco, 'gibt-es-nicht', 'Egal')).rejects.toThrow(
      'Projekt nicht gefunden',
    );
  });
});

describe('deleteProject', () => {
  test('entfernt DB-Eintrag und Projekt-Volumes, der Branch bleibt (R2)', async () => {
    const { db, config, marco, home } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    // Volumes simulieren (entstehen sonst erst beim Sandbox-Start).
    const volumeDir = projectVolumeDir(home, project.id);
    mkdirSync(join(volumeDir, 'workspace'), { recursive: true });
    mkdirSync(join(volumeDir, 'agent-config'), { recursive: true });
    expect(existsSync(volumeDir)).toBe(true);

    await deleteProject(db, marco, project.id, home);

    expect(await listProjects(db)).toHaveLength(0);
    expect(await getProject(db, project.id)).toBeNull();
    // Volumes weg …
    expect(existsSync(volumeDir)).toBe(false);
    // … aber der Git-Branch bleibt (kein Code-Verlust).
    expect(await listBranches(config.bareRepoPath)).toEqual(['marco/dashboard']);
  });

  test('funktioniert auch, wenn (noch) keine Volumes existieren', async () => {
    const { db, config, marco, home } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Ohne Volume',
      templateDir: 'pwa',
    });
    await deleteProject(db, marco, project.id, home);
    expect(await listProjects(db)).toHaveLength(0);
  });

  test('verweigert Löschen für fremde Projekte (Nicht-Admin, Volumes bleiben)', async () => {
    const { db, config, marco, home } = await setup();
    const gast = await createUser(db, 'gast');
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    const volumeDir = projectVolumeDir(home, project.id);
    mkdirSync(volumeDir, { recursive: true });
    await expect(deleteProject(db, gast, project.id, home)).rejects.toThrow('Nur der Eigentümer');
    expect(await listProjects(db)).toHaveLength(1);
    expect(existsSync(volumeDir)).toBe(true);
  });

  test('erlaubt Admins das Löschen fremder Projekte', async () => {
    // marco ist als erster User Admin; gast ist ein normaler User.
    const { db, config, marco, home } = await setup();
    const gast = await createUser(db, 'gast');
    const project = await createProject(db, config, gast, {
      name: 'Gast-Projekt',
      templateDir: 'pwa',
    });
    const volumeDir = projectVolumeDir(home, project.id);
    mkdirSync(volumeDir, { recursive: true });

    await deleteProject(db, marco, project.id, home);

    expect(await getProject(db, project.id)).toBeNull();
    expect(existsSync(volumeDir)).toBe(false);
  });
});
