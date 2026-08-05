/**
 * Preflight für `bun run dev`: verhindert Mehrfachstarts. Läuft schon eine
 * macvibes-Instanz (belegte Ports), bricht der Start mit klarer Meldung ab —
 * statt dass sich zwei Instanzen gegenseitig die Ports wegnehmen (EADDRINUSE,
 * gegenseitige SIGTERMs, hängende Sandbox-Starts).
 *
 * Bun-TS-Fassung von scripts/preflight.sh (plattformneutral, P6);
 * Port-Prüfung per TCP-Connect statt lsof.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { istPortBelegt } from './lib/prozesse';

/** Dieselben Env-Overrides wie Server und shutdown. */
export function portKonfiguration(): { web: number; server: number; egress: number } {
  return {
    web: Number(process.env['VITE_PORT'] ?? 5173),
    server: Number(process.env['PORT'] ?? 4000),
    egress: Number(process.env['MACVIBES_EGRESS_PORT'] ?? 4010),
  };
}

/** Erster nicht auskommentierter Eintrag (letzter gewinnt), ohne Quotes. */
export function adminNameAusEnvDatei(envDatei: string): string {
  if (!existsSync(envDatei)) return '';
  let name = '';
  for (const zeile of readFileSync(envDatei, 'utf8').split('\n')) {
    const match = /^\s*MACVIBES_ADMIN_USERNAME\s*=\s*(.*)$/.exec(zeile);
    if (match)
      name = (match[1] ?? '')
        .trim()
        .replace(/^["']/, '')
        .replace(/["']\s*$/, '');
  }
  return name;
}

export async function preflight(): Promise<boolean> {
  const ports = portKonfiguration();
  const belegt: string[] = [];
  for (const port of [ports.server, ports.egress, ports.web]) {
    if (await istPortBelegt(port)) belegt.push(`:${port}`);
  }
  if (belegt.length > 0) {
    console.error(`✗ macvibes läuft offenbar schon — belegte Ports: ${belegt.join(' ')}`);
    console.error('  Erst beenden:  bun run shutdown');
    console.error('  Dann erneut:   bun run dev');
    return false;
  }

  // Erst-Admin (H3): Ohne MACVIBES_ADMIN_USERNAME vergibt die Registrierung
  // keine Admin-Rolle mehr. Auf einer FRISCHEN Installation hieße das: man
  // registriert sich und kann danach niemanden freischalten, auch sich selbst
  // nicht. Das hier fängt es vor dem Start ab. Existiert die Datenbank schon,
  // bleibt die Prüfung still (ensureAdmin warnt sonst beim Serverstart).
  const envDatei = join('apps', 'server', '.env');
  const adminName = process.env['MACVIBES_ADMIN_USERNAME'] ?? adminNameAusEnvDatei(envDatei);

  // DB-Pfad wie resolveDbPath() in apps/server/src/config.ts. ACHTUNG: dessen
  // Legacy-Zweig `./data/<name>` ist relativ zum Arbeitsverzeichnis des
  // SERVERS (apps/server), dieses Skript läuft aber im Repo-Root — beide
  // Varianten prüfen, sonst gilt eine bestehende Installation als frisch.
  const kandidaten = [
    process.env['DB_PATH'] ?? '',
    join('apps', 'server', 'data', 'app.db'),
    join('data', 'app.db'),
    join(process.env['MACVIBES_HOME'] ?? join(homedir(), 'macvibes'), 'data', 'app.db'),
  ];
  const dbGefunden = kandidaten.some((pfad) => pfad !== '' && existsSync(pfad));

  if (adminName === '' && !dbGefunden) {
    console.error('✗ Frische Installation ohne MACVIBES_ADMIN_USERNAME');
    console.error('  Keine Datenbank gefunden — und kein Bootstrap-Admin benannt.');
    console.error('  Ohne ihn wird niemand Admin, und ohne Admin schaltet niemand Nutzer frei.');
    console.error('');
    console.error('  In apps/server/.env eintragen:  MACVIBES_ADMIN_USERNAME=<dein-username>');
    console.error('  Dann erneut:                    bun run dev');
    return false;
  }
  return true;
}

if (import.meta.main) {
  process.exit((await preflight()) ? 0 : 1);
}
