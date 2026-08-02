import { runGitInRepo, type ProjectRepo } from '../core/gitService';
import { projectRepoFor } from '../core/workspaceService';
import type { ChatService } from './chatService';

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
  await runGitInRepo(repo, [
    '-c',
    'user.name=macvibes',
    '-c',
    'user.email=macvibes@local',
    'commit',
    '-q',
    '-m',
    message,
  ]);
  await runGitInRepo(repo, ['push', '-q', 'origin', 'HEAD']);
  return 'committed';
}

export interface AutoCommitHookOptions {
  macvibesHome: string;
  chatService: ChatService;
}

/**
 * onTurnEnd-Hook (R8): Auto-Commit nach jedem abgeschlossenen Agent-Turn.
 * Fehler landen sichtbar als error-Zeile im Chat — nie stillschweigend.
 */
export function createTurnEndAutoCommit(
  options: AutoCommitHookOptions,
): (projectId: string, userPrompt: string) => Promise<void> {
  return async (projectId, userPrompt) => {
    const repo = projectRepoFor(options.macvibesHome, projectId);
    try {
      await autoCommit(repo, buildCommitMessage(userPrompt));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Auto-Commit für ${projectId} fehlgeschlagen:`, error);
      await options.chatService.postMessage(
        projectId,
        'error',
        `Auto-Commit fehlgeschlagen: ${message}`,
      );
    }
  };
}
