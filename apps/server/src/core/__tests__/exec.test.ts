import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnShellCommand } from '../exec';

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'macvibes-exec-'));
  // Prozessbaum mit zwei Ebenen: parent spawnt child (HTTP-Server). Genau
  // dieses Muster brach unter Windows: ein kill auf den Wrapper ließ den
  // Server weiterlaufen (Baseline-Befund processProvider.test).
  await writeFile(
    join(dir, 'parent.ts'),
    `const child = Bun.spawn(['bun', 'child.ts'], { cwd: import.meta.dir, env: process.env });\n` +
      `await child.exited;\n`,
  );
  await writeFile(
    join(dir, 'child.ts'),
    `Bun.serve({ port: Number(Bun.env['PROBE_PORT']), hostname: '127.0.0.1', fetch: () => new Response('lebt') });\n` +
      `await new Promise(() => {});\n`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = srv.port;
  srv.stop(true);
  if (port === undefined) throw new Error('kein freier Port ermittelbar');
  return port;
}

async function erreichbar(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

describe('spawnShellCommand (plattformneutrale Shell)', () => {
  test('interpretiert Shell-Syntax inkl. Env-Expansion und hängt an die Log-Datei an', async () => {
    const log = join(dir, 'aus.log');
    const eins = spawnShellCommand('echo start-$PROBE', {
      env: { ...process.env, PROBE: '42' },
      logFile: log,
    });
    expect(await eins.exited).toBe(0);
    const zwei = spawnShellCommand('echo zweite-zeile', { logFile: log });
    expect(await zwei.exited).toBe(0);
    const inhalt = await readFile(log, 'utf8');
    expect(inhalt).toContain('start-42');
    // Anhängen, nicht überschreiben (Ersatz für `>> log 2>&1`).
    expect(inhalt).toContain('zweite-zeile');
  });

  test('liefert den Exit-Code des Kommandos', async () => {
    const proc = spawnShellCommand('exit 7');
    expect(await proc.exited).toBe(7);
  });

  test('kill() beendet den ganzen Prozessbaum, nicht nur den Wrapper', async () => {
    const port = await freePort();
    const proc = spawnShellCommand('bun parent.ts', {
      cwd: dir,
      env: { ...process.env, PROBE_PORT: String(port) },
    });

    const startFrist = Date.now() + 15_000;
    while (!(await erreichbar(port))) {
      if (Date.now() > startFrist) throw new Error('Kind-Server wurde nie erreichbar');
      await Bun.sleep(100);
    }

    proc.kill();
    await proc.exited;

    // Der ENKEL-Prozess (Server) muss mitgestorben sein — kurz nachlaufen
    // lassen, tree-kill arbeitet asynchron.
    const endeFrist = Date.now() + 5_000;
    let tot = !(await erreichbar(port));
    while (!tot && Date.now() < endeFrist) {
      await Bun.sleep(100);
      tot = !(await erreichbar(port));
    }
    expect(tot).toBe(true);
  });
});
