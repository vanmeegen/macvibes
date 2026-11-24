import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { commitArgs, runGitInRepo, type ProjectRepo } from '../core/gitService';
import { projectRepoFor } from '../core/workspaceService';

export type AutoCommitResult = 'committed' | 'nothing-to-commit';

const MAX_MESSAGE_LENGTH = 72;
const PREFIX = 'Agent: ';

/** Kurzfassung der Nutzeranweisung als Commit-Message (R8). */
export function buildCommitMessage(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  const message = `${PREFIX}${collapsed}`;
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

/**
 * Committet und pusht den aktuellen Workspace-Stand in den Projekt-Branch.
 * Turns ohne Dateiänderungen erzeugen keinen leeren Commit (R8).
 */
export async function autoCommit(repo: ProjectRepo, message: string): Promise<AutoCommitResult> {
  await runGitInRepo(repo, ['add', '-A']);
  const status = await runGitInRepo(repo, ['status', '--porcelain']);
  if (status.trim().length === 0) {
    return 'nothing-to-commit';
  }
  await runGitInRepo(repo, commitArgs(message));
  await runGitInRepo(repo, ['push', '-q', 'origin', 'HEAD']);
  return 'committed';
}

export interface AutoCommitterOptions {
  macvibesHome: string;
  /**
   * Meldet einen gescheiterten Commit sichtbar im Chat des Projekts. Als
   * Funktion statt ChatService: der Committer entsteht in der Composition
   * Root VOR dem ChatService (dessen Hooks ihn brauchen).
   */
  postError: (projectId: string, text: string) => Promise<void>;
}

export interface AutoCommitter {
  /** onTurnEnd-Hook (R8): Auto-Commit nach jedem abgeschlossenen Agent-Turn. */
  afterTurn(projectId: string, userPrompt: string): Promise<void>;
  /**
   * Offenen Workspace-Stand sichern — vor jedem Sandbox-Stopp (R9) und vor
   * jedem Frischstart (N7). `reason` ist Commit-Message und Fehlertext
   * zugleich. Ohne Projekt-Repo (Projekt nie geöffnet) ein No-op.
   */
  saveOpenState(projectId: string, reason: string): Promise<void>;
}

/**
 * EINE Stelle für alle automatischen Commits samt Fehlerbehandlung: Fehler
 * landen im Server-Log UND sichtbar als error-Zeile im Chat — nie
 * stillschweigend, und nie als geworfene Exception im Turn- oder Stopp-Pfad.
 */
export function createAutoCommitter(options: AutoCommitterOptions): AutoCommitter {
  const commit = async (projectId: string, message: string, label: string): Promise<void> => {
    try {
      await autoCommit(projectRepoFor(options.macvibesHome, projectId), message);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`${label} für ${projectId} fehlgeschlagen:`, error);
      await options.postError(projectId, `${label} fehlgeschlagen: ${detail}`);
    }
  };
  return {
    afterTurn: (projectId, userPrompt) =>
      commit(projectId, buildCommitMessage(userPrompt), 'Auto-Commit'),
    saveOpenState: async (projectId, reason) => {
      // Kriterium ist das gitDir NEBEN dem Arbeitsbaum (F1) — ein `.git` im
      // Arbeitsbaum wäre gast-geschrieben und damit kein Beleg für ein Repo.
      const repo = projectRepoFor(options.macvibesHome, projectId);
      if (!existsSync(join(repo.gitDir, 'HEAD'))) return;
      await commit(projectId, reason, reason);
    },
  };
}
