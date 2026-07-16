import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runGit } from './gitService';

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
 */
export async function ensureWorkspace(params: WorkspaceParams): Promise<string> {
  const dir = workspaceDirFor(params.macvibesHome, params.projectId);
  if (existsSync(join(dir, '.git'))) {
    return dir;
  }
  mkdirSync(dirname(dir), { recursive: true });
  await runGit([
    'clone',
    '--quiet',
    '--branch',
    params.branchName,
    '--single-branch',
    params.bareRepoPath,
    dir,
  ]);
  return dir;
}
