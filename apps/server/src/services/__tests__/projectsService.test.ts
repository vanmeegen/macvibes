import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DomainError } from '../../core/errors';
import { ensureBareRepo, listBranches } from '../../core/gitService';
import {
  assertCanDeleteProject,
  copyProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  renameProject,
} from '../projectsService';
import { projectVolumeDir } from '../../core/workspaceService';
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

describe('copyProject („Kopieren und Anpassen")', () => {
  test('forkt ein FREMDES Projekt auf den eigenen Namen — Branch zeigt auf dessen HEAD', async () => {
    const { db, config, marco } = await setup();
    const gast = await createUser(db, 'gast');
    const source = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });

    const copy = await copyProject(db, config, gast, {
      sourceProjectId: source.id,
      name: 'Mein Dashboard-Fork',
    });

    expect(copy.owner.username).toBe('gast');
    expect(copy.branchName).toBe('gast/mein-dashboard-fork');
    // Template-Metadaten kommen vom Quell-Projekt (Baseline/devCommand/Port).
    expect(copy.templateDir).toBe(source.templateDir);
    expect(copy.devCommand).toBe(source.devCommand);
    expect(copy.previewPort).toBe(source.previewPort);
    // Der Fork zeigt exakt auf den HEAD des Quell-Branches.
    const proc = Bun.spawn(['git', 'rev-parse', source.branchName, copy.branchName], {
      cwd: config.bareRepoPath,
      stdout: 'pipe',
    });
    const [a, b] = (await new Response(proc.stdout).text()).trim().split('\n');
    expect(a).toBe(b);
    expect(await listProjects(db)).toHaveLength(2);
  });

  test('löst Slug-Kollisionen im eigenen Namensraum auf', async () => {
    const { db, config, marco } = await setup();
    const gast = await createUser(db, 'gast');
    const source = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    await createProject(db, config, gast, { name: 'Dashboard', templateDir: 'pwa' });

    const copy = await copyProject(db, config, gast, {
      sourceProjectId: source.id,
      name: 'Dashboard!',
    });
    // Name kollidiert als Slug mit gasts eigenem "Dashboard" → Suffix.
    expect(copy.branchName).toBe('gast/dashboard-2');
  });

  test('lehnt doppelten Projektnamen desselben Users ab', async () => {
    const { db, config, marco } = await setup();
    const source = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    await expect(
      copyProject(db, config, marco, { sourceProjectId: source.id, name: 'Dashboard' }),
    ).rejects.toThrow('bereits ein Projekt');
  });

  test('meldet unbekannte Quell-Projekte als Fehler', async () => {
    const { db, config, marco } = await setup();
    await expect(
      copyProject(db, config, marco, { sourceProjectId: 'fehlt', name: 'Egal' }),
    ).rejects.toThrow('Projekt nicht gefunden');
  });

  test('rollt den Branch zurück, wenn der DB-Insert scheitert', async () => {
    const { db, config, marco } = await setup();
    const source = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    // Insert-Fehler provozieren: users-Zeile mit kaputter id.
    const kaputt = { ...marco, id: 'gibt-es-nicht' };
    await expect(
      copyProject(db, config, kaputt, { sourceProjectId: source.id, name: 'Kopie' }),
    ).rejects.toThrow();
    expect(await listBranches(config.bareRepoPath)).toEqual(['marco/dashboard']);
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

  // Als root ist die Prämisse des Tests verletzt: chmod 555 hindert rmSync
  // nicht (root ignoriert Dateirechte), das Volume verschwindet doch — die
  // Assertions können nicht gelten. Auf den Pflicht-CI-Legs (macOS/Windows,
  // nie root) läuft der Test unverändert.
  const istRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  test.skipIf(istRoot)(
    'gilt als erfolgreich, wenn das Volume nicht entfernbar ist (rmSync wirft)',
    async () => {
      const { db, config, marco, home } = await setup();
      const project = await createProject(db, config, marco, {
        name: 'Blockiert',
        templateDir: 'pwa',
      });
      const volumeDir = projectVolumeDir(home, project.id);
      const workspace = join(volumeDir, 'workspace');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'blockiert.txt'), 'x');
      // rmSync zum Scheitern bringen — über echte fs-Zustände statt Modul-Mocks,
      // aber pro Plattform über den Mechanismus, der dort GARANTIERT greift:
      // - POSIX: das schreibgeschützte Verzeichnis verweigert das unlink der
      //   enthaltenen Datei (EACCES).
      // - Windows: chmod auf Verzeichnisse ist wirkungslos, und ein offener
      //   File-Handle blockiert das Löschen auf modernem NTFS (POSIX-Delete
      //   seit Win10 1903) nicht zuverlässig. Was dort IMMER blockiert, ist das
      //   aktuelle Arbeitsverzeichnis eines Prozesses — das OS hält den
      //   cwd-Handle ohne Delete-Sharing, rmdir(workspace) wirft EBUSY/EPERM.
      // Beides zusammen macht den rmSync-Fehler auf BEIDEN Pflicht-CI-Legs
      // deterministisch, ohne dass der Test etwas anderes als echtes
      // fs-Verhalten prüft.
      // prevCwd VOR dem try, alles Verändernde HINEIN: bliebe der cwd nach einem
      // Fehler in einer dieser Zeilen im Temp-Verzeichnis stehen, könnte afterEach
      // es unter Windows nicht mehr entfernen — der Folgefehler träfe fremde Tests.
      const prevCwd = process.cwd();
      let errorSpy: ReturnType<typeof spyOn<Console, 'error'>> | undefined;
      let logged: unknown[][] = [];
      try {
        process.chdir(workspace);
        chmodSync(workspace, 0o555);
        errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        // Ab dem DB-Delete ist das Projekt gelöscht; das Volume ist best effort.
        // Würfe deleteProject hier noch, bräche im Resolver die Aufräumkette
        // (sandboxManager.forget / chatService.forget) ab — Timer, Betrachter
        // und Chat-Zustand blieben für die Prozesslaufzeit stehen (vgl. H11).
        await expect(deleteProject(db, marco, project.id, home)).resolves.toBeUndefined();
      } finally {
        if (errorSpy) {
          logged = errorSpy.mock.calls.map((call) => [...call]);
          errorSpy.mockRestore();
        }
        // cwd ZUERST zurück (BEVOR afterEach die Temp-Verzeichnisse entfernt —
        // sonst verhinderte der cwd-Handle unter Windows auch das Testaufräumen):
        // würfe das chmod (Workspace wider Erwarten schon weg), bliebe der cwd
        // sonst im gelöschten Verzeichnis stehen und jeder folgende Spawn mit
        // cwd=process.cwd() schlüge quer durch die Suite fehl.
        process.chdir(prevCwd);
        if (existsSync(workspace)) chmodSync(workspace, 0o755);
      }
      expect(await getProject(db, project.id)).toBeNull();
      expect(await listProjects(db)).toHaveLength(0);
      // Ehrlich bleiben: der Rest liegt noch auf der Platte …
      expect(existsSync(volumeDir)).toBe(true);
      // … und der Fehler wurde geloggt (Konvention: keine verschluckten Exceptions).
      expect(logged.some((call) => String(call[0]).includes(project.id))).toBe(true);
    },
  );

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

/**
 * F10: Das Schema stoppte die Sandbox, BEVOR die Ownership geprüft war — ein
 * Fremder konnte damit eine laufende VM beenden und einen Auto-Commit im
 * fremden Branch erzwingen, obwohl die Mutation danach abgelehnt wurde. Die
 * Prüfung ist deshalb einzeln aufrufbar.
 */
describe('assertCanDeleteProject (F10)', () => {
  test('lehnt einen Fremden ab, bevor irgendetwas passiert', async () => {
    const { db, config, marco } = await setup();
    const fremder = await createUser(db, 'beggi');
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });

    await expect(assertCanDeleteProject(db, fremder, project.id)).rejects.toThrow(/Eigentümer/);
  });

  test('Eigentümer und Admin dürfen', async () => {
    const { db, config, marco } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    const admin = { ...(await createUser(db, 'chefin')), role: 'admin' as const };

    await expect(assertCanDeleteProject(db, marco, project.id)).resolves.toBeUndefined();
    await expect(assertCanDeleteProject(db, admin, project.id)).resolves.toBeUndefined();
  });

  test('unbekanntes Projekt wird als solches gemeldet', async () => {
    const { db, marco } = await setup();
    await expect(assertCanDeleteProject(db, marco, 'gibtsnicht')).rejects.toThrow(/nicht gefunden/);
  });
});
