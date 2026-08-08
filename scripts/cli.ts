#!/usr/bin/env bun
/**
 * `macvibes` — die EINE CLI-Klammer um die bestehenden Repo-Skripte
 * (installer-plan.md, Phase 0). Bewusst eine DÜNNE Schale: die Argument-
 * Auswertung ist rein und getestet (lib/cli), die Unterbefehle sind die
 * unveränderten Skripte — hier wird nichts neu implementiert.
 *
 * WARUM Bun.spawn statt direktem Import: scripts/setup.ts steht hinter
 * `import.meta.main` — importiert würde seine main() NIE laufen. dev.ts und
 * shutdown.ts laufen zwar auf Top-Level, rufen aber process.exit() und würden
 * damit DIESE CLI mitten im Dispatch beenden. Ein Subprozess mit stdio
 * 'inherit' gibt beides sauber: Ctrl+C erreicht als Konsolen-Signal die ganze
 * Vordergrund-Gruppe (POSIX wie Windows, Muster aus dev.ts) — wichtig für die
 * langlaufenden `start`/`dev` —, und der Exit-Code des Kindes wird 1:1
 * durchgereicht. Einzige Ausnahme: `doctor` braucht keinen Prozess — seine
 * Logik ist als Bibliothek importierbar (lib/doctorState + lib/setup).
 *
 * WARUM cwd = Repo-Root: der spätere Brew-Wrapper ruft die CLI aus beliebigen
 * Verzeichnissen; setup.ts/preflight.ts schreiben bzw. lesen aber relativ
 * (apps/server/.env). Der Root wird aus import.meta.url abgeleitet — der
 * Quellbaum bleibt bei der Homebrew-Installation intakt (libexec), eine
 * Pfad-Entkopplung ist deshalb bewusst NICHT nötig.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hilfeText, parseCliArgs, type CliBefehlName } from './lib/cli';
import { druckeDoctorReport, erhebeDoctorInput } from './lib/doctorState';
import { doctor } from './lib/setup';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Unterbefehl als Vordergrund-Subprozess, Exit-Code 1:1 durchreichen. */
async function delegiere(argv: string[]): Promise<never> {
  const proc = Bun.spawn(argv, {
    cwd: repoRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env as Record<string, string>,
  });
  process.exit(await proc.exited);
}

/**
 * Kommando → argv des Unterprozesses. `start` läuft über `bun run start`
 * (root package.json), damit dessen Definition (Web bauen + Server starten)
 * die eine Wahrheit bleibt; die übrigen Befehle rufen ihre Skripte direkt.
 */
function argvFuer(command: Exclude<CliBefehlName, 'doctor'>, rest: string[]): string[] {
  switch (command) {
    case 'setup':
      return ['bun', join(repoRoot, 'scripts', 'setup.ts'), ...rest];
    case 'start':
      return ['bun', 'run', 'start', ...rest];
    case 'stop':
      return ['bun', join(repoRoot, 'scripts', 'shutdown.ts'), ...rest];
    case 'dev':
      return ['bun', join(repoRoot, 'scripts', 'dev.ts'), ...rest];
  }
}

/** Report drucken; Exit 1 nur bei mind. einem fail (warns blockieren nicht). */
async function doctorBefehl(): Promise<never> {
  const report = doctor(await erhebeDoctorInput());
  druckeDoctorReport(report);
  process.exit(report.hatFehler ? 1 : 0);
}

const aktion = parseCliArgs(process.argv.slice(2));
switch (aktion.kind) {
  case 'help':
    console.log(hilfeText());
    process.exit(0);
    break;
  case 'version': {
    // Version zur Laufzeit aus der root package.json — nie hartkodiert.
    const pkg = (await Bun.file(join(repoRoot, 'package.json')).json()) as { version?: string };
    console.log(`macvibes ${pkg.version ?? 'unbekannt'}`);
    process.exit(0);
    break;
  }
  case 'unknown':
    console.error(`✗ Unbekannter Befehl: ${aktion.input}\n`);
    console.error(hilfeText());
    process.exit(1);
    break;
  case 'run':
    if (aktion.command === 'doctor') {
      await doctorBefehl();
    } else {
      await delegiere(argvFuer(aktion.command, aktion.rest));
    }
    break;
}
