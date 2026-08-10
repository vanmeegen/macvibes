/**
 * Startet den lokalen Modell-Router (LiteLLM) — wird von macvibes automatisch
 * aufgerufen (localRouterService), kann aber auch manuell laufen.
 *
 *   Endpunkt:  http://localhost:8787/v1/messages  (Anthropic-Format)
 *   Backend:   Ollama auf http://localhost:11434
 *
 * Bun-TS-Fassung von run.sh (windows-portierung-plan.md, P7): venv-Layout
 * (bin/ vs. Scripts/) und Python-Suche per Feature-Detection statt
 * Plattform-Weiche. Die Python-venv lebt AUSSERHALB des Repos
 * (~/macvibes/local-router-venv) und wird beim allerersten Start automatisch
 * angelegt (dauert einmalig ~1–2 min).
 *
 * Config-Datei: die mitgelieferte `litellm_config.yaml` liegt bei einer
 * Homebrew-Installation in `<libexec>` und wird bei jedem `brew upgrade`
 * ersetzt — nutzereigene Router-Config gehört deshalb nach
 * `<macvibesHome>/litellm.yaml` (oder explizit via
 * MACVIBES_LOCAL_ROUTER_CONFIG). Auflösung: configPath.ts.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveRouterConfigPath } from './configPath';

const hier = import.meta.dir;
const port = process.env['MACVIBES_LOCAL_ROUTER_PORT'] ?? '8787';
const macvibesHome = process.env['MACVIBES_HOME'] ?? join(homedir(), 'macvibes');
const venv = join(macvibesHome, 'local-router-venv');
// Upgrade-feste Router-Config: MACVIBES_LOCAL_ROUTER_CONFIG >
// <macvibesHome>/litellm.yaml > mitgelieferte Datei — Begründung in configPath.ts
// (die mitgelieferte liegt bei einer Installation in libexec und überlebt kein
// brew upgrade).
const configPfad = resolveRouterConfigPath({
  envPath: process.env['MACVIBES_LOCAL_ROUTER_CONFIG'],
  macvibesHome,
  bundledDir: hier,
});

/** venv-Binary per Layout-Detection: POSIX `bin/`, Windows `Scripts/`. */
function venvBinary(name: string): string | null {
  for (const kandidat of [join(venv, 'bin', name), join(venv, 'Scripts', `${name}.exe`)]) {
    if (existsSync(kandidat)) return kandidat;
  }
  return null;
}

async function lauf(cmd: string[], beschreibung: string): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) {
    console.error(`${beschreibung} schlug fehl (${cmd.join(' ')})`);
    process.exit(1);
  }
}

if (venvBinary('litellm') === null) {
  console.log(`LiteLLM-venv fehlt — lege sie einmalig an unter ${venv} …`);
  const python = ['python3.11', 'python3', 'python']
    .map((name) => Bun.which(name))
    .find((pfad) => pfad !== null);
  if (python === undefined) {
    console.error('Kein Python gefunden (gesucht: python3.11, python3, python).');
    process.exit(1);
  }
  await lauf([python, '-m', 'venv', venv], 'venv anlegen');
  const venvPython = venvBinary('python');
  if (venvPython === null) {
    console.error(`venv unter ${venv} hat kein Python-Binary — Anlage unvollständig?`);
    process.exit(1);
  }
  await lauf(
    [venvPython, '-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'],
    'pip aktualisieren',
  );
  await lauf(
    [venvPython, '-m', 'pip', 'install', '--quiet', 'litellm[proxy]'],
    'LiteLLM installieren',
  );
  console.log('LiteLLM installiert.');
}

const litellm = venvBinary('litellm');
if (litellm === null) {
  console.error(`LiteLLM-Binary nicht gefunden unter ${venv} (bin/ oder Scripts/).`);
  process.exit(1);
}

// Kein `exec`-Ersatz nötig: der localRouterService beendet bei Bedarf den
// ganzen Prozessbaum (tree-kill); manuell gestartet reicht Ctrl+C.
console.log(`LiteLLM-Config: ${configPfad}`);
const router = Bun.spawn([litellm, '--config', configPfad, '--port', port, '--host', '127.0.0.1'], {
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await router.exited);
