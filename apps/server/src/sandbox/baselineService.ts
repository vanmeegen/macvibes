import { MicrosandboxError, runMsb, waitForExecReady } from './msb';

/**
 * Template-Baselines (R9/PRD „Template-Baselines"): pro Template wird einmal
 * eine MicroVM eingefroren (Disk-Snapshot, „local fork-by-copy") mit fertig
 * installierten node_modules, dem Agent SDK (/opt/macvibes) und tini+monit
 * (In-VM-Supervisor). Neue Projekte forken die Baseline — kein Install zur
 * Laufzeit, Preview in Sekunden. Ohne Baseline bootet keine Projekt-VM.
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

  // Der Builder braucht dieselbe Ready-Wartezeit wie Projekt-VMs: `msb run -d`
  // kehrt zurück, bevor der Gast-exec-Endpunkt steht — ein sofortiges exec
  // stirbt sonst intermittierend mit "exec session ended without exit event"
  // (live getroffen beim Daemon-Integrationstest, 2026-07-06).
  await waitForExecReady(BUILDER_SANDBOX);

  // Ein exec pro Schritt statt eines Mega-Befehls: kurze exec-Sessions sind
  // bei msb deutlich robuster, und ein Fehler ist dem Schritt zuordenbar.
  // Alle Schritte sind PFLICHT: ohne SDK/tini/monit bootet keine Projekt-VM
  // (Daemon-Transport ist der einzige Agent-Pfad, architektur.md).
  const steps: { beschreibung: string; script: string }[] = [
    {
      // Das gemountete Daemon-Bundle (/opt/macvibes/bin/main.js) löst das SDK
      // von /opt/macvibes auf; die Claude-CLI bringt das SDK selbst mit.
      beschreibung: 'Agent SDK nach /opt/macvibes',
      script:
        'mkdir -p /opt/macvibes && cd /opt/macvibes && printf %s "{}" > package.json && ' +
        'bun add @anthropic-ai/claude-agent-sdk >/dev/null 2>&1',
    },
    {
      beschreibung: 'tini + monit (In-VM-Supervisor, PID 1) installieren',
      script:
        'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq tini monit >/dev/null 2>&1',
    },
    {
      // node_modules vom Host ausschließen — die VM installiert selbst (Linux-Artefakte).
      beschreibung: 'Template kopieren + Dependencies installieren',
      script:
        'mkdir -p /baseline/work && cp -r /src/. /baseline/work && rm -rf /baseline/work/node_modules && ' +
        'cd /baseline/work && bun install --silent && mkdir -p node_modules',
    },
  ];

  try {
    for (const step of steps) {
      try {
        await runMsb(['exec', BUILDER_SANDBOX, '--', 'sh', '-c', step.script]);
      } catch (error) {
        throw new MicrosandboxError(
          `Baseline-Schritt „${step.beschreibung}" fehlgeschlagen: ${String(error)}`,
        );
      }
    }
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
