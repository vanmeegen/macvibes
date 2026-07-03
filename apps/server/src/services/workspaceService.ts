import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runGit } from './gitService';

export interface WorkspaceParams {
  macvibesHome: string;
  bareRepoPath: string;
  projectId: string;
  branchName: string;
}

/** Persistentes Projekt-Volume: ~/macvibes/volumes/<projectId>/workspace (R9). */
export function workspaceDirFor(macvibesHome: string, projectId: string): string {
  return join(macvibesHome, 'volumes', projectId, 'workspace');
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
