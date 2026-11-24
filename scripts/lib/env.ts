import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { macvibesHomeDir, parseEnvFile } from '@macvibes/shared/node';

/**
 * Das macvibes-Home (`MACVIBES_HOME`, sonst `~/macvibes`) — dieselbe Funktion,
 * die auch der Server nutzt (@macvibes/shared/node).
 */
export function macvibesHome(): string {
  return macvibesHomeDir();
}

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
function standardEnvDateien(): string[] {
  return [join('apps', 'server', '.env'), join(macvibesHome(), '.env')];
}

/**
 * Wert eines Schlüssels aus einer .env-Datei — mit DEMSELBEN Parser wie der
 * Server (@macvibes/shared/node: spätere Zeilen gewinnen, umschließende
 * Quotes entfernt, keine Expansion). Eine fehlende Datei ist kein Fehler.
 */
export function wertAusEnvDatei(datei: string, name: string): string | undefined {
  if (!existsSync(datei)) return undefined;
  return parseEnvFile(readFileSync(datei, 'utf8'))[name];
}
