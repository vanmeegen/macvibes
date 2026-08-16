import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Env-Wert mit .env-Datei-Fallback — für Skripte, die dieselbe Konfiguration
 * sehen müssen wie der Server.
 *
 * Der Server liest `Bun.env`, und das enthält zu seinem Startzeitpunkt die
 * automatisch geladene cwd-`.env` (apps/server/.env — der in CLAUDE.md
 * dokumentierte Ort) plus die explizit nachgeladene `<macvibesHome>/.env`.
 * Ein Skript wie `bun run shutdown` läuft im Repo-Root und sieht BEIDE
 * Dateien nicht — ein dort gesetztes MACVIBES_MAX_SANDBOXES ginge an der
 * Grace-Berechnung vorbei, und die maschinell bewachte Budget-Invariante
 * (shutdownTimings) gälte nur auf dem Papier.
 *
 * Vorrangordnung wie beim Server: echte Prozess-Env > cwd-nahe Datei
 * (apps/server/.env) > Home-Datei (<macvibesHome>/.env).
 */
export function envWertMitDateiFallback(
  name: string,
  dateien: string[] = standardEnvDateien(),
): string | undefined {
  const ausProzess = process.env[name];
  if (ausProzess !== undefined && ausProzess !== '') return ausProzess;
  for (const datei of dateien) {
    const wert = wertAusEnvDatei(datei, name);
    if (wert !== undefined) return wert;
  }
  return undefined;
}

/** Die beiden .env-Orte, die auch der Server sieht (Reihenfolge = Vorrang). */
export function standardEnvDateien(): string[] {
  const home = process.env['MACVIBES_HOME'] ?? join(homedir(), 'macvibes');
  return [join('apps', 'server', '.env'), join(home, '.env')];
}

/**
 * Letzter KEY=VALUE-Treffer einer .env-Datei (wie dotenv: spätere Zeilen
 * gewinnen), Anführungszeichen abgestreift. Kein Expansions-/Escape-Support —
 * die macvibes-.env-Dateien sind schlichte KEY=VALUE-Listen (setup.ts).
 */
export function wertAusEnvDatei(datei: string, name: string): string | undefined {
  if (!existsSync(datei)) return undefined;
  let wert: string | undefined;
  const muster = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`);
  for (const zeile of readFileSync(datei, 'utf8').split('\n')) {
    const match = muster.exec(zeile);
    if (match) {
      wert = (match[1] ?? '')
        .trim()
        .replace(/^["']/, '')
        .replace(/["']\s*$/, '');
    }
  }
  return wert;
}
