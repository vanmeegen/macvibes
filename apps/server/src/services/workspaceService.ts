import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runGit, type ProjectRepo } from './gitService';

export interface WorkspaceParams {
  macvibesHome: string;
  bareRepoPath: string;
  projectId: string;
  branchName: string;
}

/** Verzeichnis aller Volumes eines Projekts (Workspace + Agent-Config). */
export function projectVolumeDir(macvibesHome: string, projectId: string): string {
  return join(macvibesHome, 'volumes', projectId);
}

/** Persistentes Projekt-Volume: ~/macvibes/volumes/<projectId>/workspace (R9). */
export function workspaceDirFor(macvibesHome: string, projectId: string): string {
  return join(projectVolumeDir(macvibesHome, projectId), 'workspace');
}

/**
 * git-Metadaten des Projekts — BEWUSST außerhalb des Workspace, weil der
 * Workspace read-write in die Sandbox gemountet wird. Läge `.git` darin,
 * könnte der Agent Hooks/Config schreiben, die der Host beim Auto-Commit
 * als Host-Nutzer ausführt (Ausbruch aus der VM).
 */
export function gitDirFor(macvibesHome: string, projectId: string): string {
  return join(projectVolumeDir(macvibesHome, projectId), 'git');
}

/** gitDir + Arbeitsbaum eines Projekts — Eingabe für `runGitInRepo`. */
export function projectRepoFor(macvibesHome: string, projectId: string): ProjectRepo {
  return {
    gitDir: gitDirFor(macvibesHome, projectId),
    workTree: workspaceDirFor(macvibesHome, projectId),
  };
}

/**
 * Persistente Agent-Config (Claude-Code-Sessiondaten) pro Projekt, getrennt
 * vom git-Workspace — sonst würde der Auto-Commit die Sessiondateien einchecken.
 * Wird in die VM gemountet, damit `--resume` einen VM-Neustart übersteht (R9).
 */
export function agentConfigDirFor(macvibesHome: string, projectId: string): string {
  return join(projectVolumeDir(macvibesHome, projectId), 'agent-config');
}

/**
 * Persistenter Bun-Install-Cache pro Projekt (ADR 0002): hält NUR die per
 * `bun add` nachinstallierten Delta-Pakete — die Basis kommt weiter aus dem
 * Baseline-Snapshot. Pro Projekt statt global, damit nie zwei VMs gleichzeitig
 * in dasselbe virtiofs-Verzeichnis schreiben.
 */
export function bunCacheDirFor(macvibesHome: string, projectId: string): string {
  return join(projectVolumeDir(macvibesHome, projectId), 'bun-cache');
}

/**
 * Klont den Projekt-Branch beim ersten Start in das Projekt-Volume;
 * ein bestehendes Volume wird unverändert wiederverwendet (R9).
 *
 * Die git-Metadaten landen dabei außerhalb des Arbeitsbaums (F1): der
 * Arbeitsbaum wird read-write in die Sandbox gemountet, das gitDir nie.
 */
export async function ensureWorkspace(params: WorkspaceParams): Promise<string> {
  const dir = workspaceDirFor(params.macvibesHome, params.projectId);
  const gitDir = gitDirFor(params.macvibesHome, params.projectId);

  if (existsSync(join(gitDir, 'HEAD'))) {
    removeStrayGitEntry(dir, params.projectId, { expected: false });
    return dir;
  }

  // Alt-Volume aus der Zeit vor der Härtung: gitDir aus dem Arbeitsbaum
  // herausziehen. `origin` zeigt bereits aufs Bare-Repo und bleibt gültig.
  if (existsSync(join(dir, '.git'))) {
    renameSync(join(dir, '.git'), gitDir);
    await runGit(['--git-dir', gitDir, 'config', 'core.bare', 'false']);
    console.log(`Workspace ${params.projectId}: git-Metadaten nach ${gitDir} migriert`);
    return dir;
  }

  mkdirSync(dirname(dir), { recursive: true });
  await runGit([
    'clone',
    '--quiet',
    '--branch',
    params.branchName,
    '--single-branch',
    '--separate-git-dir',
    gitDir,
    params.bareRepoPath,
    dir,
  ]);
  // `clone --separate-git-dir` hinterlässt eine .git-DATEI im Arbeitsbaum.
  // Die ist gast-beschreibbar und damit ein Umleitungsvektor — weg damit.
  removeStrayGitEntry(dir, params.projectId, { expected: true });
  return dir;
}

/**
 * Entfernt alles, was im Arbeitsbaum `.git` heißt. Der Gast kann es jederzeit
 * neu anlegen; host-seitig ist es wirkungslos (wir übergeben gitDir explizit),
 * aber es hat dort nichts zu suchen. Fehler werden nur geloggt — sonst könnte
 * der Gast den Sandbox-Start per DoS blockieren.
 *
 * `expected` unterscheidet den Normalfall (git legt die Datei beim Klonen
 * selbst an) vom Auffälligen: nur Letzteres ist eine Warnung wert.
 */
function removeStrayGitEntry(
  workspaceDir: string,
  projectId: string,
  options: { expected: boolean },
): void {
  const stray = join(workspaceDir, '.git');
  if (!existsSync(stray)) return;
  try {
    rmSync(stray, { recursive: true, force: true });
    if (!options.expected) {
      console.warn(`Workspace ${projectId}: verirrtes .git im Arbeitsbaum entfernt`);
    }
  } catch (error) {
    console.error(`Workspace ${projectId}: .git im Arbeitsbaum nicht entfernbar:`, error);
  }
}
