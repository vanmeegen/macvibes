#!/usr/bin/env bun
/**
 * Stress-Suite für VM-Lebenszyklus und Turn-Handling (apps/web/e2e-stress).
 *
 * Startet eine GETRENNTE Testinstallation neben einem laufenden macvibes —
 * eigene Ports, eigenes Home, eigene Datenbank, aber echte MicroVMs und echter
 * Claude —, legt einen Wegwerf-Nutzer an, fährt die Szenarien und baut alles
 * wieder ab. Die produktive Instanz wird nicht angefasst.
 *
 *   bun run stress                 # alle Szenarien
 *   bun run stress befunde         # nur Dateien, die „befunde" im Namen tragen
 *
 * Voraussetzungen: msb + Baselines (`bun run baselines`) und ein
 * CLAUDE_CODE_OAUTH_TOKEN oder ANTHROPIC_API_KEY in apps/server/.env.
 * Hintergrund: docs/haertung-turn-und-vm-2026-11.md.
 */
import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnvFile } from '@macvibes/shared/node';

const REPO = resolve(import.meta.dir, '..');
const PORTS = { server: 4100, egress: 4110, gateway: 4273 } as const;
const GRACE_MS = 8000;
const BASE_URL = `http://127.0.0.1:${PORTS.server}`;

function zufall(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex');
}

async function erreichbar(): Promise<boolean> {
  try {
    await fetch(BASE_URL, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    // Nicht erreichbar ist hier eine Antwort, kein Fehler.
    return false;
  }
}

async function laufe(
  kommando: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<number> {
  const proc = Bun.spawn(kommando, { cwd, env, stdout: 'inherit', stderr: 'inherit' });
  return proc.exited;
}

if (await erreichbar()) {
  console.error(`Port ${PORTS.server} ist belegt — läuft noch eine Testinstallation?`);
  process.exit(2);
}

// Zugangsdaten für die Claude-API aus der Server-.env — nur diese eine Angabe,
// keine Konfiguration der produktiven Instanz.
const serverEnv = parseEnvFile(readFileSync(join(REPO, 'apps', 'server', '.env'), 'utf8'));
const credential: Record<string, string> = {};
for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const) {
  const wert = serverEnv[name];
  if (wert !== undefined && wert !== '') credential[name] = wert;
}
if (Object.keys(credential).length === 0) {
  console.error('Weder CLAUDE_CODE_OAUTH_TOKEN noch ANTHROPIC_API_KEY in apps/server/.env.');
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), 'macvibes-stress-'));
const serverLog = join(home, 'server.log');
const nutzer = 'stresstest';
const passwort = zufall(12);
const bootstrap = zufall(16);
const basisEnv: Record<string, string> = {
  HOME: process.env['HOME'] ?? '',
  PATH: process.env['PATH'] ?? '',
  TMPDIR: process.env['TMPDIR'] ?? tmpdir(),
};

console.log('Baue das Web-Frontend …');
if ((await laufe(['bun', 'run', 'build'], join(REPO, 'apps', 'web'), { ...basisEnv })) !== 0) {
  rmSync(home, { recursive: true, force: true });
  process.exit(2);
}

console.log(`Starte die Testinstallation auf ${BASE_URL} (Home: ${home}) …`);
const log = openSync(serverLog, 'w');
const server = Bun.spawn(['bun', 'run', join(REPO, 'apps', 'server', 'src', 'index.ts')], {
  // Eigenes Arbeitsverzeichnis: Bun lädt sonst die .env der produktiven Instanz.
  cwd: home,
  env: {
    ...basisEnv,
    ...credential,
    MACVIBES_HOME: home,
    DB_PATH: join(home, 'app.db'),
    MACVIBES_ADMIN_USERNAME: nutzer,
    MACVIBES_ADMIN_BOOTSTRAP_TOKEN: bootstrap,
    MACVIBES_SANDBOX: 'microsandbox',
    MACVIBES_GRACE_MS: String(GRACE_MS),
    HOST: '127.0.0.1',
    PORT: String(PORTS.server),
    MACVIBES_EGRESS_PORT: String(PORTS.egress),
    MACVIBES_PREVIEW_GATEWAY_PORT: String(PORTS.gateway),
  },
  stdout: log,
  stderr: log,
});

let exitCode = 1;
try {
  let oben = false;
  for (let i = 0; i < 160 && !oben; i++) {
    oben = await erreichbar();
    if (!oben) await Bun.sleep(500);
  }
  if (!oben) throw new Error(`Server kam nicht hoch — siehe ${serverLog}`);

  const antwort = await fetch(`${BASE_URL}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({
      query:
        'mutation($u:String!,$p:String!,$b:String){register(username:$u,password:$p,bootstrapToken:$b){username}}',
      variables: { u: nutzer, p: passwort, b: bootstrap },
    }),
  });
  const ergebnis = (await antwort.json()) as { errors?: unknown };
  if (ergebnis.errors !== undefined) {
    throw new Error(`Testnutzer nicht anlegbar: ${JSON.stringify(ergebnis.errors)}`);
  }

  exitCode = await laufe(
    [
      'bunx',
      'playwright',
      'test',
      '--config',
      'playwright.stress.config.ts',
      ...process.argv.slice(2),
    ],
    join(REPO, 'apps', 'web'),
    {
      ...basisEnv,
      MACVIBES_BASE_URL: BASE_URL,
      MACVIBES_LIVE_USER: nutzer,
      MACVIBES_LIVE_PASS: passwort,
      MACVIBES_LIVE_SERVER_LOG: serverLog,
      MACVIBES_LIVE_GRACE_MS: String(GRACE_MS),
      MACVIBES_STRESS_SERVER_PID: String(server.pid),
    },
  );
} finally {
  // Ein Szenario beendet den Server selbst; dann ist hier nichts mehr zu tun.
  server.kill('SIGTERM');
  await Promise.race([server.exited, Bun.sleep(60_000)]);
  if (exitCode === 0) {
    rmSync(home, { recursive: true, force: true });
  } else {
    console.error(`Fehlgeschlagen — Server-Log und Daten bleiben liegen: ${home}`);
  }
}
process.exit(exitCode);
