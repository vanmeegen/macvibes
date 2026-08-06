import { desc, eq } from 'drizzle-orm';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildBranchName,
  deriveBranchSlug,
  projectNameSchema,
  resolveSlugCollision,
} from '@macvibes/shared';
import { AGENT_MODELS, DEFAULT_AGENT_MODEL, isKnownAgentModel } from '../agent/agentModel';
import type { Db } from '../db/client';
import { projects, users, type ProjectRow, type UserRow } from '../db/schema';
import { DomainError } from '../core/errors';
import {
  createProjectBranch,
  deleteBranch,
  ensureBareRepo,
  forkBranch,
  listBranches,
} from '../core/gitService';
import { loadTemplates } from './templatesService';
import { projectVolumeDir } from '../core/workspaceService';

export interface ProjectsConfig {
  bareRepoPath: string;
  templatesDir: string;
}

export interface ProjectWithOwner extends ProjectRow {
  owner: UserRow;
}

export async function listProjects(db: Db): Promise<ProjectWithOwner[]> {
  const rows = await db
    .select()
    .from(projects)
    .innerJoin(users, eq(projects.ownerId, users.id))
    .orderBy(desc(projects.lastActivityAt));
  return rows.map((row) => ({ ...row.projects, owner: row.users }));
}

export async function getProject(db: Db, id: string): Promise<ProjectWithOwner | null> {
  const rows = await db
    .select()
    .from(projects)
    .innerJoin(users, eq(projects.ownerId, users.id))
    .where(eq(projects.id, id))
    .limit(1);
  const row = rows[0];
  return row ? { ...row.projects, owner: row.users } : null;
}

/**
 * Lädt ein Projekt und erzwingt STRIKTE Ownership — bewusst OHNE Admin-
 * Ausnahme, anders als renameProject/deleteProject (dort Owner ODER Admin):
 * fremde Projekte sind les-, kopier- und betretbar (R10), aber Chatten,
 * Stoppen und Modellwahl bleiben dem Eigentümer vorbehalten.
 *
 * Lebt seit M5 hier im Service statt als Resolver-Helper: die Regel hängt
 * damit an den Operationen selbst (chatService.sendMessage/stopTurn,
 * setProjectAgentModel prüfen selbst) und nicht an der Disziplin des
 * jeweiligen Transports.
 */
export async function getProjectOwned(
  db: Db,
  currentUser: UserRow,
  id: string,
): Promise<ProjectWithOwner> {
  const project = await getProject(db, id);
  if (!project) {
    throw new DomainError('Projekt nicht gefunden');
  }
  if (project.ownerId !== currentUser.id) {
    throw new DomainError('Nur der Eigentümer kann mit diesem Projekt arbeiten');
  }
  return project;
}

/**
 * Setzt das Agenten-Modell eines Projekts (Dropdown im Chat). Owner-only
 * (M5, Prüfung hier im Service); validiert gegen den Modellkatalog. Ein
 * laufender Turn bleibt unberührt, der NÄCHSTE Turn nutzt das neue Modell
 * (die Session startet dabei frisch — s. chatService).
 */
export async function setProjectAgentModel(
  db: Db,
  currentUser: UserRow,
  projectId: string,
  model: string,
): Promise<ProjectWithOwner> {
  // ERST autorisieren, DANN validieren/schreiben (F10-Muster): ein Fremder
  // erfährt nur „nicht der Eigentümer", nicht den Modellkatalog.
  const project = await getProjectOwned(db, currentUser, projectId);
  if (!isKnownAgentModel(model)) {
    throw new DomainError(
      `Unbekanntes Modell "${model}" — wählbar sind: ${AGENT_MODELS.map((m) => m.id).join(', ')}`,
    );
  }
  await db.update(projects).set({ agentModel: model }).where(eq(projects.id, projectId));
  return { ...project, agentModel: model };
}

export async function createProject(
  db: Db,
  config: ProjectsConfig,
  owner: UserRow,
  input: { name: string; templateDir: string },
): Promise<ProjectWithOwner> {
  const templates = await loadTemplates(config.templatesDir);
  const template = templates.find((t) => t.dir === input.templateDir);
  if (!template) {
    throw new DomainError(`Unbekanntes Template: ${input.templateDir}`);
  }

  await ensureBareRepo(config.bareRepoPath);
  const { name, branchName } = await resolveNewProjectName(db, config, owner, input.name);

  await createProjectBranch(
    config.bareRepoPath,
    branchName,
    join(config.templatesDir, template.dir),
  );

  return insertProjectRow(db, config, owner, {
    name,
    branchName,
    templateDir: template.dir,
    devCommand: template.devCommand,
    previewPort: template.previewPort,
  });
}

/**
 * Fügt die Projektzeile ein, NACHDEM der Git-Branch bereits angelegt wurde —
 * gemeinsamer Abschluss von createProject (Template-Metadaten) und copyProject
 * (Metadaten des Quell-Projekts). Scheitert der Insert, wird der frisch
 * angelegte Branch zurückgerollt: kein halb-angelegtes Projekt hinterlassen
 * (R1) — weder verwaister Branch noch DB-Zeile ohne Branch.
 */
async function insertProjectRow(
  db: Db,
  config: ProjectsConfig,
  owner: UserRow,
  values: {
    name: string;
    branchName: string;
    templateDir: string;
    devCommand: string;
    previewPort: number;
  },
): Promise<ProjectWithOwner> {
  try {
    const inserted = await db
      .insert(projects)
      .values({
        id: crypto.randomUUID(),
        ...values,
        ownerId: owner.id,
        // Neue Chats starten mit dem Default-Modell (Sonnet 5, env-übersteuerbar).
        agentModel: DEFAULT_AGENT_MODEL,
      })
      .returning();
    const project = inserted[0];
    if (!project) {
      throw new Error('Projekt-Insert lieferte keine Zeile zurück');
    }
    return { ...project, owner };
  } catch (error) {
    // Kein halb-angelegtes Projekt hinterlassen (R1): Branch zurückrollen.
    await deleteBranch(config.bareRepoPath, values.branchName);
    throw error;
  }
}

/**
 * Validiert den Wunschnamen, prüft Duplikate im Namensraum des Owners und
 * liefert einen kollisionsfreien Branch-Namen — gemeinsamer Unterbau von
 * createProject und copyProject.
 */
async function resolveNewProjectName(
  db: Db,
  config: ProjectsConfig,
  owner: UserRow,
  rawName: string,
): Promise<{ name: string; branchName: string }> {
  const nameResult = projectNameSchema.safeParse(rawName);
  if (!nameResult.success) {
    throw new DomainError(nameResult.error.issues[0]?.message ?? 'Ungültiger Projektname');
  }
  const name = nameResult.data;

  const duplicate = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.ownerId, owner.id));
  if (duplicate.some((p) => p.name === name)) {
    throw new DomainError(`Du hast bereits ein Projekt namens „${name}"`);
  }

  // Slug-Kollisionen nur innerhalb des User-Namensraums auflösen (R1).
  const prefix = `${owner.username}/`;
  const takenSlugs = new Set(
    (await listBranches(config.bareRepoPath))
      .filter((branch) => branch.startsWith(prefix))
      .map((branch) => branch.slice(prefix.length)),
  );
  const slug = resolveSlugCollision(deriveBranchSlug(name), takenSlugs);
  return { name, branchName: buildBranchName(owner.username, slug) };
}

/**
 * „Kopieren und Anpassen": forkt ein beliebiges (auch fremdes) Projekt auf
 * den eigenen Namen. Der neue Branch zeigt auf den HEAD des Quell-Branches —
 * voller Entwicklungsstand statt Template-Baseline; die Template-Metadaten
 * (Baseline-Snapshot, devCommand, Preview-Port) erbt die Kopie vom Original.
 */
export async function copyProject(
  db: Db,
  config: ProjectsConfig,
  owner: UserRow,
  input: { sourceProjectId: string; name: string },
): Promise<ProjectWithOwner> {
  const source = await getProject(db, input.sourceProjectId);
  if (!source) {
    throw new DomainError('Projekt nicht gefunden');
  }
  await ensureBareRepo(config.bareRepoPath);
  const { name, branchName } = await resolveNewProjectName(db, config, owner, input.name);

  await forkBranch(config.bareRepoPath, branchName, source.branchName);

  return insertProjectRow(db, config, owner, {
    name,
    branchName,
    templateDir: source.templateDir,
    devCommand: source.devCommand,
    previewPort: source.previewPort,
  });
}

/**
 * Benennt ein Projekt um (nur der Anzeigename). Der Git-Branch behält bewusst
 * seinen Slug — er ist die stabile Identität des Projekts im Bare-Repo.
 */
export async function renameProject(
  db: Db,
  currentUser: UserRow,
  id: string,
  newName: string,
): Promise<ProjectWithOwner> {
  const nameResult = projectNameSchema.safeParse(newName);
  if (!nameResult.success) {
    throw new DomainError(nameResult.error.issues[0]?.message ?? 'Ungültiger Projektname');
  }
  const name = nameResult.data;

  const project = await getProject(db, id);
  if (!project) {
    throw new DomainError('Projekt nicht gefunden');
  }
  if (project.ownerId !== currentUser.id && currentUser.role !== 'admin') {
    throw new DomainError('Nur der Eigentümer oder ein Admin kann ein Projekt umbenennen');
  }

  // Duplikate im Namensraum des EIGENTÜMERS prüfen — auch wenn ein Admin
  // ein fremdes Projekt umbenennt.
  const siblings = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.ownerId, project.ownerId));
  if (siblings.some((p) => p.id !== id && p.name === name)) {
    throw new DomainError(`Du hast bereits ein Projekt namens „${name}"`);
  }

  await db.update(projects).set({ name }).where(eq(projects.id, id));
  return { ...project, name };
}

/**
 * Autorisierung fürs Löschen — getrennt ausführbar, damit der Resolver sie VOR
 * jedem Seiteneffekt aufrufen kann (F10). Vorher stoppte das Schema die
 * Sandbox, bevor die Ownership überhaupt geprüft war: ein Fremder konnte damit
 * eine laufende VM samt erzwungenem Auto-Commit beenden, obwohl die Mutation
 * anschließend abgelehnt wurde.
 */
export async function assertCanDeleteProject(
  db: Db,
  currentUser: UserRow,
  id: string,
): Promise<void> {
  const project = await getProject(db, id);
  if (!project) {
    throw new DomainError('Projekt nicht gefunden');
  }
  if (project.ownerId !== currentUser.id && currentUser.role !== 'admin') {
    throw new DomainError('Nur der Eigentümer oder ein Admin kann ein Projekt löschen');
  }
}

export async function deleteProject(
  db: Db,
  currentUser: UserRow,
  id: string,
  macvibesHome: string,
): Promise<void> {
  await assertCanDeleteProject(db, currentUser, id);
  await db.delete(projects).where(eq(projects.id, id));
  // Volumes (Workspace + Agent-Config) entfernen; der Git-Branch bleibt
  // bewusst erhalten (R2) — kein Code-Verlust, nur der lokale Stand geht weg.
  //
  // Best effort — INVARIANTE: ab dem DB-Delete wirft deleteProject nicht mehr.
  // Das Projekt IST dann gelöscht; würfe ein fehlgeschlagenes rmSync (unter
  // Windows plausibel: EBUSY/EPERM auf offene Handles) hier noch, meldete die
  // Mutation einen Fehler für eine längst vollzogene Löschung — und der
  // Resolver käme nie zu sandboxManager.forget / chatService.forget: Timer,
  // Betrachter-Refcounts und Chat-Zustand des toten Projekts blieben für die
  // Prozesslaufzeit stehen (genau das Leck, gegen das H11 absichert). Der
  // liegengebliebene Verzeichnisrest kostet nur Platte und wird geloggt.
  try {
    rmSync(projectVolumeDir(macvibesHome, id), { recursive: true, force: true });
  } catch (error) {
    console.error(
      `Projekt ${id}: Volumes nicht vollständig entfernbar, Rest bleibt liegen:`,
      error,
    );
  }
}
