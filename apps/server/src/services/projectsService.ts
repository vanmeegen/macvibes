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
import { DomainError } from './errors';
import { createProjectBranch, deleteBranch, ensureBareRepo, listBranches } from './gitService';
import { loadTemplates } from './templatesService';
import { projectVolumeDir } from './workspaceService';

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
 * Setzt das Agenten-Modell eines Projekts (Dropdown im Chat). Validiert gegen
 * den Modellkatalog; ein laufender Turn bleibt unberührt, der NÄCHSTE Turn
 * nutzt das neue Modell (die Session startet dabei frisch — s. chatService).
 */
export async function setProjectAgentModel(
  db: Db,
  projectId: string,
  model: string,
): Promise<void> {
  if (!isKnownAgentModel(model)) {
    throw new DomainError(
      `Unbekanntes Modell "${model}" — wählbar sind: ${AGENT_MODELS.map((m) => m.id).join(', ')}`,
    );
  }
  await db.update(projects).set({ agentModel: model }).where(eq(projects.id, projectId));
}

export async function createProject(
  db: Db,
  config: ProjectsConfig,
  owner: UserRow,
  input: { name: string; templateDir: string },
): Promise<ProjectWithOwner> {
  const nameResult = projectNameSchema.safeParse(input.name);
  if (!nameResult.success) {
    throw new DomainError(nameResult.error.issues[0]?.message ?? 'Ungültiger Projektname');
  }
  const name = nameResult.data;

  const templates = await loadTemplates(config.templatesDir);
  const template = templates.find((t) => t.dir === input.templateDir);
  if (!template) {
    throw new DomainError(`Unbekanntes Template: ${input.templateDir}`);
  }

  const duplicate = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.ownerId, owner.id));
  if (duplicate.some((p) => p.name === name)) {
    throw new DomainError(`Du hast bereits ein Projekt namens „${name}"`);
  }

  await ensureBareRepo(config.bareRepoPath);

  // Slug-Kollisionen nur innerhalb des User-Namensraums auflösen (R1).
  const prefix = `${owner.username}/`;
  const takenSlugs = new Set(
    (await listBranches(config.bareRepoPath))
      .filter((branch) => branch.startsWith(prefix))
      .map((branch) => branch.slice(prefix.length)),
  );
  const slug = resolveSlugCollision(deriveBranchSlug(name), takenSlugs);
  const branchName = buildBranchName(owner.username, slug);

  await createProjectBranch(
    config.bareRepoPath,
    branchName,
    join(config.templatesDir, template.dir),
  );

  try {
    const inserted = await db
      .insert(projects)
      .values({
        id: crypto.randomUUID(),
        name,
        branchName,
        templateDir: template.dir,
        devCommand: template.devCommand,
        previewPort: template.previewPort,
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
    await deleteBranch(config.bareRepoPath, branchName);
    throw error;
  }
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
  if (project.ownerId !== currentUser.id) {
    throw new DomainError('Nur der Eigentümer kann ein Projekt umbenennen');
  }

  const siblings = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.ownerId, currentUser.id));
  if (siblings.some((p) => p.id !== id && p.name === name)) {
    throw new DomainError(`Du hast bereits ein Projekt namens „${name}"`);
  }

  await db.update(projects).set({ name }).where(eq(projects.id, id));
  return { ...project, name };
}

export async function deleteProject(
  db: Db,
  currentUser: UserRow,
  id: string,
  macvibesHome: string,
): Promise<void> {
  const project = await getProject(db, id);
  if (!project) {
    throw new DomainError('Projekt nicht gefunden');
  }
  if (project.ownerId !== currentUser.id) {
    throw new DomainError('Nur der Eigentümer kann ein Projekt löschen');
  }
  await db.delete(projects).where(eq(projects.id, id));
  // Volumes (Workspace + Agent-Config) entfernen; der Git-Branch bleibt
  // bewusst erhalten (R2) — kein Code-Verlust, nur der lokale Stand geht weg.
  rmSync(projectVolumeDir(macvibesHome, id), { recursive: true, force: true });
}
