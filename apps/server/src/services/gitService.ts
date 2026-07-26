import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/** Wird beim Kopieren eines Templates in den Initial-Commit ausgelassen. */
const COPY_EXCLUDES = new Set(['node_modules', 'dist', '.git', 'data']);

/**
 * Ein Projekt-Repository, dessen git-Metadaten BEWUSST außerhalb des
 * Arbeitsbaums liegen: der Arbeitsbaum wird read-write in die Sandbox
 * gemountet, das gitDir nie. Siehe `runGitInRepo`.
 */
export interface ProjectRepo {
  /** git-Metadaten, host-only (~/macvibes/volumes/<id>/git). */
  gitDir: string;
  /** Arbeitsbaum, in der Sandbox beschreibbar (~/macvibes/volumes/<id>/workspace). */
  workTree: string;
}

/**
 * Env-Härtung: keine System-/Nutzer-Config, keine interaktiven Prompts, und
 * vor allem keine geerbten GIT_*-Variablen, die gitDir oder Objektspeicher
 * umbiegen könnten.
 */
const SAFE_GIT_ENV: Record<string, string | undefined> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/false',
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_CONFIG: undefined,
  GIT_CONFIG_COUNT: undefined,
};

export async function runGit(
  args: string[],
  cwd?: string,
  envOverrides?: Record<string, string | undefined>,
): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: cwd ?? process.cwd(),
    ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
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

/**
 * Config-Härtung für git-Aufrufe auf gast-kontrollierten Arbeitsbäumen.
 * Zweite Verteidigungslinie: Primär schützt bereits das explizite
 * `--git-dir`/`--work-tree`, weil git dann keine Repo-Discovery durch den
 * Arbeitsbaum macht und dessen `.git` gar nicht erst liest.
 */
const GIT_HARDENING = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'protocol.ext.allow=never',
];

/**
 * git-Aufruf auf einem Projekt-Repository, dessen Arbeitsbaum dem nicht
 * vertrauenswürdigen Agenten gehört (F1).
 *
 * Übergibt gitDir und Arbeitsbaum IMMER explizit — damit entfällt die
 * Repo-Discovery, und eine vom Gast untergeschobene `.git`-Datei im
 * Arbeitsbaum bleibt wirkungslos. Ohne das würden Hooks, `core.fsmonitor`
 * oder eine `ext::`-Remote-URL aus gast-geschriebener Config als Host-Nutzer
 * ausgeführt.
 */
export async function runGitInRepo(repo: ProjectRepo, args: string[]): Promise<string> {
  assertSafeRepo(repo);
  return runGit(
    ['--git-dir', repo.gitDir, '--work-tree', repo.workTree, ...GIT_HARDENING, ...args],
    repo.workTree,
    SAFE_GIT_ENV,
  );
}

/**
 * Der einzige Aufruf-Vertrag, der F1 verhindert: die git-Metadaten dürfen
 * nicht im gast-beschreibbaren Arbeitsbaum liegen.
 */
export function assertSafeRepo(repo: ProjectRepo): void {
  if (!isAbsolute(repo.gitDir) || !isAbsolute(repo.workTree)) {
    throw new GitError(
      `gitDir und Arbeitsbaum müssen absolut sein (gitDir=${repo.gitDir}, workTree=${repo.workTree})`,
    );
  }
  const gitDir = resolve(repo.gitDir);
  const workTree = resolve(repo.workTree);
  if (gitDir === workTree || gitDir.startsWith(`${workTree}${sep}`)) {
    throw new GitError(
      `gitDir darf nicht im Arbeitsbaum liegen (gitDir=${gitDir}, Arbeitsbaum=${workTree})`,
    );
  }
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
