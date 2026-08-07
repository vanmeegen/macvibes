import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../../db/client';
import { projects, type ProjectRow } from '../../db/schema';
import { ensureBareRepo } from '../../core/gitService';
import { projectVolumeDir, workspaceDirFor } from '../../core/workspaceService';
import type { SandboxContext } from '../../sandbox/provider';
import { createProject, getProject } from '../projectsService';
import {
  deleteProjectAndCleanup,
  enterProjectSession,
  sandboxContextFor,
  sendMessageToProject,
  type ChatSessionPort,
  type SandboxLifecycle,
} from '../projectSessionService';
import {
  createTempDir,
  createTemplatesFixture,
  createTestDb,
  createUser,
  removeDir,
} from './testUtils';

/**
 * Stufe 1: Der Helfer bündelt die zuvor an DREI Stellen (chatEvents,
 * enterProject, sendMessage) wortgleich duplizierte Sechs-Felder-Konstruktion
 * des Sandbox-Startkontexts. Der Test nagelt fest, dass GENAU diese sechs
 * Felder mit den erwarteten Werten geliefert werden.
 */
function fakeProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 'p1',
    name: 'Testprojekt',
    branchName: 'marco/testprojekt',
    templateDir: 'pwa',
    devCommand: 'bun run dev',
    previewPort: 5173,
    ownerId: 'u1',
    agentModel: 'claude-sonnet',
    claudeSessionId: null,
    claudeSessionModel: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  } as ProjectRow;
}

describe('sandboxContextFor (Stufe 1)', () => {
  test('liefert exakt die sechs Startkontext-Felder eines Projekts', () => {
    const macvibesHome = '/tmp/macvibes-home';
    const context = sandboxContextFor(fakeProject(), macvibesHome);

    expect(context).toEqual({
      projectId: 'p1',
      branchName: 'marco/testprojekt',
      workspaceDir: workspaceDirFor(macvibesHome, 'p1'),
      templateDir: 'pwa',
      devCommand: 'bun run dev',
      previewPort: 5173,
    });
    // Genau sechs Felder — kein Feld schleicht sich zusätzlich ein.
    expect(Object.keys(context).sort()).toEqual(
      [
        'branchName',
        'devCommand',
        'previewPort',
        'projectId',
        'templateDir',
        'workspaceDir',
      ].sort(),
    );
  });

  test('workspaceDir folgt macvibesHome + Projekt-ID (core/workspaceService)', () => {
    const context = sandboxContextFor(fakeProject({ id: 'abc' }), '/data/home');
    expect(context.workspaceDir).toBe(join('/data/home', 'volumes', 'abc', 'workspace'));
  });

  /**
   * Drift-Schutz (entkoppelt von der enter()-Aufrufstelle in schema/index.ts):
   * `SandboxRunContext` (services) spiegelt `SandboxContext` (sandbox/provider)
   * bewusst dupliziert, damit die Kante services→sandbox tot bleibt. Bisher
   * fing NUR die einzige Resolver-Zeile `enter(sandboxContextFor(...))` einen
   * Drift beider Typen zur Kompilierzeit. Baut jemand diese Zeile um, verschwände
   * der Schutz lautlos. Dieser type-level Test hält ihn unabhängig: das Ergebnis
   * von `sandboxContextFor` MUSS einem echten `SandboxContext` zuweisbar sein —
   * exakt was der Provider-Aufruf verlangt. Fällt ein Feld weg oder ändert einen
   * Typ, bricht `bun run typecheck` schon an dieser Zuweisung.
   */
  test('bleibt zu sandbox/provider.SandboxContext driftfrei (type-level)', () => {
    const context = sandboxContextFor(fakeProject(), '/data/home');
    const asProviderContext: SandboxContext = context;
    expect(asProviderContext).toBe(context);
  });
});

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

/**
 * Sandbox-/Chat-Fakes, die nur die Aufruf-REIHENFOLGE protokollieren — der
 * Use-Case braucht keine echte VM. `stop` merkt sich zusätzlich, ob das Projekt
 * zum Stopp-Zeitpunkt noch existiert (beweist: Stopp VOR dem DB-Delete, R2/F10).
 */
function fakes(db: Db, opts: { resumeResult?: boolean } = {}) {
  const calls: string[] = [];
  let existedAtStop: boolean | null = null;
  const sandbox: SandboxLifecycle = {
    ensureRunning: async (context) => {
      calls.push(`ensureRunning:${context.projectId}`);
    },
    stop: async (id: string) => {
      existedAtStop = (await getProject(db, id)) !== null;
      calls.push(`stop:${id}`);
    },
    forget: (id: string) => {
      calls.push(`sandbox.forget:${id}`);
    },
  };
  const chat: ChatSessionPort = {
    resumeUnansweredTurn: async (_user, id: string) => {
      calls.push(`resume:${id}`);
      return opts.resumeResult ?? false;
    },
    prewarm: async (_user, id: string) => {
      calls.push(`prewarm:${id}`);
    },
    sendMessage: async (_user, input) => {
      calls.push(`sendMessage:${input.projectId}:${input.text}:${input.interrupt === true}`);
    },
    forget: (id: string) => {
      calls.push(`chat.forget:${id}`);
    },
  };
  return { calls, sandbox, chat, existedAtStop: () => existedAtStop };
}

/**
 * Stufe 2: Die deleteProject-Aufräumkette (F10 → stop(R2) → deleteProject →
 * forget×2) war auf Resolver-Ebene UNGETESTET. Diese Tests hängen direkt am
 * Service und belegen Reihenfolge und forget-Semantik.
 */
describe('deleteProjectAndCleanup (Stufe 2)', () => {
  test('fremder User: wirft VOR jedem Seiteneffekt (kein stop, kein forget, F10)', async () => {
    const { db, config, marco, home } = await setup();
    const gast = await createUser(db, 'gast');
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    const { calls, sandbox, chat } = fakes(db);

    await expect(
      deleteProjectAndCleanup({ db, sandbox, chat, macvibesHome: home }, gast, project.id),
    ).rejects.toThrow('Nur der Eigentümer');

    // Kein einziger Seiteneffekt — die Autorisierung kommt zuerst.
    expect(calls).toEqual([]);
    expect(await getProject(db, project.id)).not.toBeNull();
  });

  test('Erfolgspfad: stop → deleteProject → forget(sandbox) → forget(chat) in dieser Reihenfolge', async () => {
    const { db, config, marco, home } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Dashboard',
      templateDir: 'pwa',
    });
    const f = fakes(db);

    await deleteProjectAndCleanup(
      { db, sandbox: f.sandbox, chat: f.chat, macvibesHome: home },
      marco,
      project.id,
    );

    expect(f.calls).toEqual([
      `stop:${project.id}`,
      `sandbox.forget:${project.id}`,
      `chat.forget:${project.id}`,
    ]);
    // Stopp lief, SOLANGE das Projekt noch existierte (Stopp vor Volume-/DB-Entfernung, R2).
    expect(f.existedAtStop()).toBe(true);
    // … und danach ist es weg.
    expect(await getProject(db, project.id)).toBeNull();
  });

  test('rmSync-Fehler: deleteProject wirft NICHT → forget×2 läuft trotzdem', async () => {
    const { db, config, marco, home } = await setup();
    const project = await createProject(db, config, marco, {
      name: 'Blockiert',
      templateDir: 'pwa',
    });
    const f = fakes(db);
    // Volume so präparieren, dass rmSync scheitert — exakt wie im
    // projectsService-Test: schreibgeschütztes Verzeichnis (POSIX) bzw.
    // cwd-Handle (Windows) blockiert das Entfernen deterministisch.
    const volumeDir = projectVolumeDir(home, project.id);
    const workspace = join(volumeDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'blockiert.txt'), 'x');
    const prevCwd = process.cwd();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.chdir(workspace);
      chmodSync(workspace, 0o555);
      await expect(
        deleteProjectAndCleanup(
          { db, sandbox: f.sandbox, chat: f.chat, macvibesHome: home },
          marco,
          project.id,
        ),
      ).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      chmodSync(workspace, 0o755);
      process.chdir(prevCwd);
    }

    // deleteProject warf nicht (Volume best effort ab dem DB-Delete) — also
    // lief die Kette weiter: forget wird trotz liegengebliebenem Volume erledigt.
    expect(f.calls).toEqual([
      `stop:${project.id}`,
      `sandbox.forget:${project.id}`,
      `chat.forget:${project.id}`,
    ]);
    expect(await getProject(db, project.id)).toBeNull();
    // Ehrlich: der Rest liegt noch auf der Platte.
    expect(existsSync(volumeDir)).toBe(true);
  });
});

/** Setzt lastActivityAt auf einen alten Fixwert, damit ein touchProject sichtbar bumpt. */
const OLD = new Date('2020-01-01T00:00:00.000Z');
async function ageProject(db: Db, id: string): Promise<void> {
  await db.update(projects).set({ lastActivityAt: OLD }).where(eq(projects.id, id));
}
async function lastActivity(db: Db, id: string): Promise<Date> {
  const project = await getProject(db, id);
  if (!project) throw new Error('Projekt weg');
  return project.lastActivityAt;
}

/**
 * Stufe 3: Die enterProject-Orchestrierung (ensureRunning immer, Owner-Gate,
 * resume/prewarm-Ausschließlichkeit, touchProject nur Owner) war bisher nur
 * mittelbar abgedeckt. Diese Tests hängen direkt am Service.
 */
describe('enterProjectSession (Stufe 3)', () => {
  test('Owner ohne offenen Turn: ensureRunning → resume(false) → prewarm, dann touch', async () => {
    const { db, config, marco, home } = await setup();
    const project = await createProject(db, config, marco, { name: 'App', templateDir: 'pwa' });
    await ageProject(db, project.id);
    const f = fakes(db, { resumeResult: false });

    await enterProjectSession(
      { db, sandbox: f.sandbox, chat: f.chat, macvibesHome: home },
      marco,
      project,
    );

    // resume und prewarm schließen sich aus — hier kein Resume, also prewarm.
    expect(f.calls).toEqual([
      `ensureRunning:${project.id}`,
      `resume:${project.id}`,
      `prewarm:${project.id}`,
    ]);
    // touchProject lief (nur Owner): Aktivität wurde gebumpt.
    expect((await lastActivity(db, project.id)).getTime()).toBeGreaterThan(OLD.getTime());
  });

  test('Owner MIT wiederaufgenommenem Turn: KEIN prewarm (Ausschließlichkeit)', async () => {
    const { db, config, marco, home } = await setup();
    const project = await createProject(db, config, marco, { name: 'App', templateDir: 'pwa' });
    await ageProject(db, project.id);
    const f = fakes(db, { resumeResult: true });

    await enterProjectSession(
      { db, sandbox: f.sandbox, chat: f.chat, macvibesHome: home },
      marco,
      project,
    );

    // resume === true → prewarm bleibt aus.
    expect(f.calls).toEqual([`ensureRunning:${project.id}`, `resume:${project.id}`]);
    expect(f.calls).not.toContain(`prewarm:${project.id}`);
    expect((await lastActivity(db, project.id)).getTime()).toBeGreaterThan(OLD.getTime());
  });

  test('Nur-Lese-Besucher: nur ensureRunning — kein resume/prewarm, kein touch (R10)', async () => {
    const { db, config, marco, home } = await setup();
    const gast = await createUser(db, 'gast');
    const project = await createProject(db, config, marco, { name: 'App', templateDir: 'pwa' });
    await ageProject(db, project.id);
    const f = fakes(db);

    await enterProjectSession(
      { db, sandbox: f.sandbox, chat: f.chat, macvibesHome: home },
      gast,
      project,
    );

    // Sandbox startet immer (Live-Preview für fremde Projekte, R10) …
    expect(f.calls).toEqual([`ensureRunning:${project.id}`]);
    // … aber kein Owner-Effekt: die Aktivitätssortierung bleibt unangetastet.
    expect((await lastActivity(db, project.id)).getTime()).toBe(OLD.getTime());
  });
});

/**
 * Stufe 3: Die sendMessage-Kette (getProjectOwned(F10) → trim-Validierung →
 * ensureRunning(R6) → sendMessage → touch) war bisher nur mittelbar abgedeckt.
 */
describe('sendMessageToProject (Stufe 3)', () => {
  test('Erfolgspfad: ensureRunning → sendMessage(getrimmt, interrupt) → touch', async () => {
    const { db, config, marco, home } = await setup();
    const project = await createProject(db, config, marco, { name: 'App', templateDir: 'pwa' });
    await ageProject(db, project.id);
    const f = fakes(db);

    await sendMessageToProject(
      { db, sandbox: f.sandbox, chat: f.chat, macvibesHome: home },
      marco,
      {
        projectId: project.id,
        text: '  hallo  ',
        interrupt: true,
      },
    );

    // Reihenfolge fix; Text getrimmt; interrupt durchgereicht.
    expect(f.calls).toEqual([
      `ensureRunning:${project.id}`,
      `sendMessage:${project.id}:hallo:true`,
    ]);
    expect((await lastActivity(db, project.id)).getTime()).toBeGreaterThan(OLD.getTime());
  });

  test('fremder User: getProjectOwned wirft VOR ensureRunning/sendMessage (F10)', async () => {
    const { db, config, marco, home } = await setup();
    const gast = await createUser(db, 'gast');
    const project = await createProject(db, config, marco, { name: 'App', templateDir: 'pwa' });
    const f = fakes(db);

    await expect(
      sendMessageToProject({ db, sandbox: f.sandbox, chat: f.chat, macvibesHome: home }, gast, {
        projectId: project.id,
        text: 'hallo',
        interrupt: false,
      }),
    ).rejects.toThrow('Nur der Eigentümer');

    // Kein Seiteneffekt vor der Autorisierung.
    expect(f.calls).toEqual([]);
  });

  test('leerer Text: wirft NACH getProjectOwned, aber VOR ensureRunning/sendMessage', async () => {
    const { db, config, marco, home } = await setup();
    const project = await createProject(db, config, marco, { name: 'App', templateDir: 'pwa' });
    const f = fakes(db);

    await expect(
      sendMessageToProject({ db, sandbox: f.sandbox, chat: f.chat, macvibesHome: home }, marco, {
        projectId: project.id,
        text: '   ',
        interrupt: false,
      }),
    ).rejects.toThrow('Nachricht darf nicht leer sein');

    // Validierung sitzt vor der Sandbox — kein Start für eine leere Nachricht.
    expect(f.calls).toEqual([]);
  });
});
