import { afterEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeAgentRunner } from '../../agent/fakeRunner';
import { autoCommit, buildCommitMessage, createTurnEndAutoCommit } from '../autoCommitService';
import { ChatService } from '../chatService';
import { createProjectBranch, ensureBareRepo, runGit } from '../gitService';
import { ensureWorkspace } from '../workspaceService';
import {
  createTempDir,
  createTemplatesFixture,
  createTestDb,
  createUser,
  removeDir,
} from './testUtils';
import { projects } from '../../db/schema';
import type { Db } from '../../db/client';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error('waitFor: Bedingung nicht erfüllt');
}

async function setupWorkspace(): Promise<{ home: string; bare: string; workspace: string }> {
  const home = await createTempDir('macvibes-home-');
  tempDirs.push(home);
  const templates = await createTemplatesFixture();
  tempDirs.push(templates);
  const bare = join(home, 'macvibes-apps.git');
  await ensureBareRepo(bare);
  await createProjectBranch(bare, 'marco/projekt', join(templates, 'pwa'));
  const workspace = await ensureWorkspace({
    macvibesHome: home,
    bareRepoPath: bare,
    projectId: 'projekt-1',
    branchName: 'marco/projekt',
  });
  return { home, bare, workspace };
}

async function commitCount(bare: string, branch: string): Promise<number> {
  const out = await runGit(['rev-list', '--count', branch], bare);
  return Number(out.trim());
}

describe('buildCommitMessage (R8)', () => {
  test('referenziert die Nutzeranweisung als Kurzfassung', () => {
    expect(buildCommitMessage('Baue mir ein Dashboard')).toBe('Agent: Baue mir ein Dashboard');
  });

  test('kollabiert Whitespace und kürzt auf 72 Zeichen', () => {
    const long = 'Bitte    baue\nmir '.concat('x'.repeat(100));
    const message = buildCommitMessage(long);
    expect(message.length).toBeLessThanOrEqual(72);
    expect(message).toContain('Agent: Bitte baue mir');
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('autoCommit (R8)', () => {
  test('committet Änderungen und pusht in den Projekt-Branch', async () => {
    const { bare, workspace } = await setupWorkspace();
    const before = await commitCount(bare, 'marco/projekt');

    await writeFile(join(workspace, 'neu.txt'), 'vom Agenten erzeugt');
    const result = await autoCommit(workspace, 'Agent: Neues Feature');

    expect(result).toBe('committed');
    expect(await commitCount(bare, 'marco/projekt')).toBe(before + 1);
    const log = await runGit(['log', '-1', '--format=%s', 'marco/projekt'], bare);
    expect(log.trim()).toBe('Agent: Neues Feature');
  });

  test('erzeugt keinen leeren Commit ohne Änderungen', async () => {
    const { bare, workspace } = await setupWorkspace();
    const before = await commitCount(bare, 'marco/projekt');

    const result = await autoCommit(workspace, 'Agent: Nichts passiert');

    expect(result).toBe('nothing-to-commit');
    expect(await commitCount(bare, 'marco/projekt')).toBe(before);
  });
});

describe('createTurnEndAutoCommit — Integration mit ChatService (R8)', () => {
  async function createProjectRow(db: Db, ownerId: string): Promise<void> {
    await db.insert(projects).values({
      id: 'projekt-1',
      name: 'Projekt',
      branchName: 'marco/projekt',
      templateDir: 'pwa',
      devCommand: 'bun run dev',
      previewPort: 5173,
      ownerId,
    });
  }

  test('Agent-Turn mit Dateiänderung wird automatisch committet', async () => {
    const { home, bare, workspace } = await setupWorkspace();
    const db = createTestDb();
    const owner = await createUser(db, 'marco');
    await createProjectRow(db, owner.id);
    const before = await commitCount(bare, 'marco/projekt');

    let chatService: ChatService | null = null;
    const hook = (projectId: string, prompt: string) => {
      if (!chatService) throw new Error('ChatService fehlt');
      return createTurnEndAutoCommit({ macvibesHome: home, chatService })(projectId, prompt);
    };
    chatService = new ChatService(db, new FakeAgentRunner(1), { onTurnEnd: hook });

    await chatService.sendMessage({
      projectId: 'projekt-1',
      workspaceDir: workspace,
      resumeSessionId: null,
      text: 'SCHREIBE eine Notiz',
    });
    await waitFor(async () => (await commitCount(bare, 'marco/projekt')) === before + 1);

    const log = await runGit(['log', '-1', '--format=%s', 'marco/projekt'], bare);
    expect(log.trim()).toBe('Agent: SCHREIBE eine Notiz');
    // Kein Fehler im Chat.
    const messages = await chatService.listMessages('projekt-1');
    expect(messages.some((m) => m.role === 'error')).toBe(false);
  });

  test('Commit-Fehler landet sichtbar als error-Zeile im Chat', async () => {
    const db = createTestDb();
    const owner = await createUser(db, 'marco');
    await createProjectRow(db, owner.id);
    const home = await createTempDir('macvibes-kaputt-');
    tempDirs.push(home);

    const chatService = new ChatService(db, new FakeAgentRunner(1), {});
    // Workspace existiert nicht → autoCommit muss scheitern.
    const hook = createTurnEndAutoCommit({ macvibesHome: home, chatService });
    await hook('projekt-1', 'Irgendwas');

    const messages = await chatService.listMessages('projekt-1');
    const error = messages.find((m) => m.role === 'error');
    expect(error?.content).toContain('Auto-Commit');
  });
});
