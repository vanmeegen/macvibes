import { MicrosandboxError, runMsb } from './msb';

/**
 * Template-Baselines (R9/PRD „Template-Baselines"): pro Template wird einmal
 * eine MicroVM mit fertig installierten node_modules eingefroren
 * (Disk-Snapshot, „local fork-by-copy"). Neue Projekte forken die Baseline —
 * kein `bun install` mehr zur Laufzeit, Preview in Sekunden.
 */

const BUILDER_SANDBOX = 'macvibes-baseline-builder';

export function baselineSnapshotName(templateDir: string): string {
  return `macvibes-tpl-${templateDir}`;
}

/** Existiert ein Snapshot mit diesem Namen? */
export async function snapshotExists(name: string): Promise<boolean> {
  try {
    await runMsb(['snapshot', 'inspect', name]);
    return true;
  } catch (error) {
    if (error instanceof MicrosandboxError) return false;
    throw error;
  }
}

export async function baselineExists(templateDir: string): Promise<boolean> {
  return snapshotExists(baselineSnapshotName(templateDir));
}

/** Entfernt einen Snapshot (für Tests — Produktions-Baselines nicht anfassen). */
export async function removeSnapshot(name: string): Promise<void> {
  try {
    await runMsb(['snapshot', 'remove', name]);
  } catch (error) {
    if (!(error instanceof MicrosandboxError)) throw error;
  }
}

export interface BuildBaselineOptions {
  templatesDir: string;
  templateDir: string;
  image: string;
  /**
   * Zielname des Snapshots. Default: `macvibes-tpl-<templateDir>`.
   * Tests MÜSSEN einen isolierten Namen setzen, sonst überschreiben sie die
   * echte Produktions-Baseline (die dann leere node_modules hätte).
   */
  snapshotName?: string;
}

/**
 * Ziel-Snapshotname für einen Baseline-Bau: der explizite Override, sonst der
 * Produktionsname. Reine Funktion — der Override ist der Mechanismus, mit dem
 * Tests die Produktions-Baselines isoliert halten (Regression 2026-07-04).
 */
export function resolveBaselineSnapshotName(options: {
  templateDir: string;
  snapshotName?: string;
}): string {
  return options.snapshotName ?? baselineSnapshotName(options.templateDir);
}

/** Baut/erneuert den Baseline-Snapshot eines Templates (bun install in der VM). */
export async function buildTemplateBaseline(options: BuildBaselineOptions): Promise<void> {
  const snapshotName = resolveBaselineSnapshotName(options);
  const templatePath = `${options.templatesDir}/${options.templateDir}`;

  // Builder-VM: Template read-only mounten, VM-lokal kopieren und installieren.
  await runMsb([
    'run',
    '-d',
    '--no-tty',
    '--replace',
    '-q',
    '--name',
    BUILDER_SANDBOX,
    '-v',
    `${templatePath}:/src:ro`,
    options.image,
    '--',
    'sleep',
    'infinity',
  ]);

  try {
    await runMsb([
      'exec',
      BUILDER_SANDBOX,
      '--',
      'sh',
      '-c',
      // node_modules vom Host ausschließen — die VM installiert selbst (Linux-Artefakte).
      // Claude Code global installieren (Agent läuft in der VM, B5c).
      'bun add -g @anthropic-ai/claude-code >/dev/null 2>&1 && ' +
        'mkdir -p /baseline/work && cp -r /src/. /baseline/work && rm -rf /baseline/work/node_modules && ' +
        'cd /baseline/work && bun install --silent && mkdir -p node_modules',
    ]);
    await runMsb(['stop', BUILDER_SANDBOX]);
    await runMsb(['snapshot', 'create', '--force', '-q', '--from', BUILDER_SANDBOX, snapshotName]);
  } finally {
    try {
      await runMsb(['rm', BUILDER_SANDBOX]);
    } catch (error) {
      console.error(`Builder-Sandbox konnte nicht entfernt werden:`, error);
    }
  }
}
