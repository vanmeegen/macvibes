import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** Wird beim Kopieren eines Templates in den Initial-Commit ausgelassen. */
const COPY_EXCLUDES = new Set(['node_modules', 'dist', '.git', 'data']);

export async function runGit(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: cwd ?? process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new GitError(`git ${args.join(' ')} schlug fehl (${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

export async function ensureBareRepo(bareRepoPath: string): Promise<void> {
  if (existsSync(join(bareRepoPath, 'HEAD'))) return;
  mkdirSync(dirname(bareRepoPath), { recursive: true });
  await runGit(['init', '--bare', '--initial-branch=main', bareRepoPath]);
}

export async function listBranches(bareRepoPath: string): Promise<string[]> {
  const out = await runGit(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
    bareRepoPath,
  );
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Erzeugt einen Orphan-Branch im Bare-Repo, dessen Initial-Commit den
 * Template-Inhalt enthält (R1). Arbeitet in einem Temp-Verzeichnis und
 * räumt es garantiert wieder auf.
 */
export async function createProjectBranch(
  bareRepoPath: string,
  branchName: string,
  templatePath: string,
): Promise<void> {
  const existing = await listBranches(bareRepoPath);
  if (existing.includes(branchName)) {
    throw new GitError(`Branch ${branchName} existiert bereits`);
  }
  const workDir = await mkdtemp(join(tmpdir(), 'macvibes-init-'));
  try {
    cpSync(templatePath, workDir, {
      recursive: true,
      filter: (source) => !COPY_EXCLUDES.has(basename(source)),
    });
    await runGit(['init', '-q', '--initial-branch=init'], workDir);
    await runGit(['add', '-A'], workDir);
    await runGit(
      [
        '-c',
        'user.name=macvibes',
        '-c',
        'user.email=macvibes@local',
        'commit',
        '-q',
        '-m',
        `Initial: Template ${basename(templatePath)}`,
      ],
      workDir,
    );
    await runGit(['push', '-q', bareRepoPath, `HEAD:refs/heads/${branchName}`], workDir);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Forkt einen Branch im Bare-Repo („Kopieren und Anpassen"): der neue Branch
 * zeigt auf den HEAD des Quell-Branches — voller Entwicklungsstand samt
 * Historie, NICHT die Template-Baseline.
 */
export async function forkBranch(
  bareRepoPath: string,
  newBranch: string,
  sourceBranch: string,
): Promise<void> {
  const existing = await listBranches(bareRepoPath);
  if (!existing.includes(sourceBranch)) {
    throw new GitError(`Quell-Branch ${sourceBranch} existiert nicht`);
  }
  if (existing.includes(newBranch)) {
    throw new GitError(`Branch ${newBranch} existiert bereits`);
  }
  await runGit(['branch', newBranch, sourceBranch], bareRepoPath);
}

/** Entfernt einen Branch aus dem Bare-Repo (nur für Rollback beim Anlegen). */
export async function deleteBranch(bareRepoPath: string, branchName: string): Promise<void> {
  await runGit(['update-ref', '-d', `refs/heads/${branchName}`], bareRepoPath);
}
