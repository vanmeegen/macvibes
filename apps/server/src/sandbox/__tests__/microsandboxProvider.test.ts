import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { buildDaemonBundle } from '../../agent/daemonBundle';
import { baselineExists, buildTemplateBaseline } from '../baselineService';
import {
  createTempDir,
  createTemplatesFixture,
  removeDir,
} from '../../services/__tests__/testUtils';
import { createProjectBranch, ensureBareRepo } from '../../core/gitService';
import { workspaceDirFor } from '../../core/workspaceService';
import {
  AGENT_CONFIG_GUEST_DIR,
  microsandboxSandboxName,
  MicrosandboxSandboxProvider,
  mountSource,
  msbAvailable,
  previewPortMapping,
} from '../microsandboxProvider';
import { execShell, listSandboxNames } from '../msbClient';
import { PortAllocator } from '../portService';
import type { SandboxHandle } from '../provider';
import type { MicrosandboxProviderConfig } from '../microsandboxProvider';

const available = await msbAvailable();
// msb#1218 (Fix upstream gemerged, in 0.6.8 noch nicht released): `cp` auf
// ro-gemountete Dateien scheitert unter Windows (close → EACCES) — der
// Baseline-Bau in der Builder-VM, den beforeAll hier braucht, ist damit auf
// Windows blockiert (windows-portierung.md, Stufe 0). Bis zum Fix-Release
// überspringen; auf macOS läuft die Suite unverändert.
const vmTestsLauffaehig = available && process.platform !== 'win32';

/**
 * Stabiler Fixture-Template-Name → Snapshot `macvibes-tpl-msbtest-v2` bleibt
 * zwischen Testläufen bestehen (apt/SDK-Install nur beim ersten Lauf, CI
 * bleibt schnell). Die VERSION HOCHZÄHLEN, wenn sich das Fixture ändert
 * (createTemplatesFixture, z. B. server.ts) — sonst testet der Lauf den alten
 * Snapshot-Stand.
 */
const FIXTURE_TEMPLATE_DIR = 'msbtest-v2';

const tempDirs: string[] = [];
let activeHandle: SandboxHandle | null = null;
let bundleDir = '';

beforeAll(async () => {
  if (!vmTestsLauffaehig) return;
  bundleDir = await createTempDir('macvibes-bundle-');
  await buildDaemonBundle(bundleDir);
  if (!(await baselineExists(FIXTURE_TEMPLATE_DIR))) {
    const templates = await createTemplatesFixture(FIXTURE_TEMPLATE_DIR);
    try {
      // Mit Daemon-Zubehör (tini/monit/SDK): der Provider setzt es voraus.
      // Dauert Minuten (apt + bun add) — daher der großzügige Hook-Timeout.
      await buildTemplateBaseline({
        templatesDir: templates,
        templateDir: FIXTURE_TEMPLATE_DIR,
        image: 'oven/bun:1.3.14',
      });
    } finally {
      await removeDir(templates);
    }
  }
}, 900_000);

afterEach(async () => {
  await activeHandle?.stop();
  activeHandle = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
}, 60_000);

afterAll(async () => {
  if (bundleDir.length > 0) await removeDir(bundleDir);
});

// Läuft immer (reine Funktionen, kein msb nötig).
describe('Mount-Quellen (msb 0.6.8)', () => {
  test('löst symbolische Links im Quellpfad auf', async () => {
    // msb 0.6.8 folgt Symlinks in der Mount-Quelle NICHT mehr und scheitert mit
    // "Not a directory". Auf macOS trifft das jeden Pfad unter $TMPDIR, weil
    // /var ein Symlink auf /private/var ist.
    const echt = await createTempDir('macvibes-mount-echt-');
    tempDirs.push(echt);
    const link = join(echt, 'zeiger');
    mkdirSync(join(echt, 'ziel'));
    // 'junction' braucht unter Windows keine Sonderrechte; auf POSIX wird
    // der Typ-Parameter ignoriert — identisches Verhalten wie zuvor.
    symlinkSync(join(echt, 'ziel'), link, 'junction');

    const aufgeloest = realpathSync(link);
    const quelle = mountSource(link, '/work');
    // Plattformneutral über realpathSync statt '/ziel:'-Literal (der
    // Host-Pfad-Trenner ist unter Windows '\').
    expect(quelle).toBe(`${aufgeloest}:/work`);
    expect(quelle.startsWith(link)).toBe(false);
  });

  test('hängt Optionen unverändert an', async () => {
    const dir = await createTempDir('macvibes-mount-opt-');
    tempDirs.push(dir);
    expect(mountSource(dir, '/etc/macvibes', 'ro').endsWith(':/etc/macvibes:ro')).toBe(true);
  });

  test('lässt einen bereits aufgelösten Pfad unverändert', async () => {
    const dir = await createTempDir('macvibes-mount-plain-');
    tempDirs.push(dir);
    const aufgeloest = realpathSync(dir);
    expect(mountSource(aufgeloest, '/work')).toBe(`${aufgeloest}:/work`);
  });
});

describe('Preview-Port-Mapping (H1)', () => {
  test('bindet den VM-Port ausschließlich an das Host-Loopback', () => {
    expect(previewPortMapping(43210, 5173)).toBe('127.0.0.1:43210:5173');
  });

  test('veröffentlicht den Port NICHT im LAN', () => {
    // 0.0.0.0 machte den hohen VM-Port direkt aus dem LAN erreichbar und
    // umging damit beide Kontrollen des Preview-Gateways: die Session-Prüfung
    // (F19) und das Entfernen des Session-Cookies auf dem Weg in die VM (F2).
    const mapping = previewPortMapping(43210, 5173);
    expect(mapping).not.toContain('0.0.0.0');
    expect(mapping.startsWith('127.0.0.1:')).toBe(true);
  });
});

/** Provider-Konfiguration mit totem Gateway — der Daemon idlet nur (Reconnects). */
function providerConfig(home: string, bare: string): MicrosandboxProviderConfig {
  return {
    macvibesHome: home,
    bareRepoPath: bare,
    image: 'oven/bun:1.3.14',
    cpus: 1,
    memoryMib: 512,
    agentDaemon: {
      bundleDir,
      envFor: (sandboxName) => ({
        MACVIBES_AGENT_GATEWAY_URL: `ws://host.microsandbox.internal:9/agent?sandbox=${sandboxName}&token=test`,
        MACVIBES_AGENT_CWD: '/work',
      }),
    },
    // Kein Gateway im Test: keine Pushes — der Status kommt aus der Probe.
    subscribePreviewStatus: () => () => undefined,
  };
}

async function projectSetup(projectId: string): Promise<{ home: string; bare: string }> {
  const home = await createTempDir('macvibes-home-');
  tempDirs.push(home);
  const templates = await createTemplatesFixture(FIXTURE_TEMPLATE_DIR);
  tempDirs.push(templates);
  const bare = join(home, 'macvibes-apps.git');
  await ensureBareRepo(bare);
  await createProjectBranch(bare, `marco/${projectId}`, join(templates, FIXTURE_TEMPLATE_DIR));
  return { home, bare };
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return await response.text();
    } catch {
      // VM bootet noch — weiter pollen.
    }
    await Bun.sleep(300);
  }
  throw new Error(`Preview unter ${url} wurde nicht erreichbar`);
}

describe.skipIf(!vmTestsLauffaehig)('MicrosandboxSandboxProvider (R7/R9, echte MicroVM)', () => {
  test(
    'startet devCommand unter monit, mappt den Preview-Port und stoppt sauber',
    async () => {
      const { home, bare } = await projectSetup('vm-projekt');
      const provider = new MicrosandboxSandboxProvider(providerConfig(home, bare));

      const workspaceDir = workspaceDirFor(home, 'vm-projekt');
      const handle = await provider.start({
        projectId: 'vm-projekt',
        branchName: 'marco/vm-projekt',
        workspaceDir,
        templateDir: FIXTURE_TEMPLATE_DIR,
        devCommand: 'bun server.ts',
        previewPort: 5199,
      });
      activeHandle = handle;

      expect(handle.previewHostPort).not.toBeNull();
      const body = await waitForHttp(`http://localhost:${handle.previewHostPort}/`);
      expect(body).toBe('hallo-preview');

      // node_modules ist ein Symlink in den Snapshot — kein Install zur Laufzeit (B5b).
      const stat = lstatSync(join(workspaceDir, 'node_modules'), { throwIfNoEntry: false });
      expect(stat?.isSymbolicLink()).toBe(true);

      // Host-Gateway (Credential-Proxy-Pfad, B5c): die VM erreicht den Host
      // über host.microsandbox.internal — die net-rule des Providers muss das erlauben.
      const hostServer = Bun.serve({
        port: 0,
        hostname: '0.0.0.0',
        fetch: () => new Response('host-erreicht'),
      });
      try {
        const gatewayProbe = Bun.spawn(
          [
            'msb',
            'exec',
            'macvibes-vm-projekt',
            '--',
            'bun',
            '-e',
            `const r = await fetch('http://host.microsandbox.internal:${hostServer.port}/', { signal: AbortSignal.timeout(5000) }); console.log(await r.text());`,
          ],
          { stdout: 'pipe', stderr: 'ignore' },
        );
        const gatewayOut = await new Response(gatewayProbe.stdout).text();
        expect(await gatewayProbe.exited).toBe(0);
        expect(gatewayOut).toContain('host-erreicht');
      } finally {
        hostServer.stop(true);
      }

      await handle.stop();
      activeHandle = null;
      await Bun.sleep(500);
      let reachable = true;
      try {
        await fetch(`http://localhost:${handle.previewHostPort}/`, {
          signal: AbortSignal.timeout(1500),
        });
      } catch {
        reachable = false;
      }
      expect(reachable).toBe(false);
    },
    { timeout: 120_000 },
  );

  test('ohne Baseline-Snapshot scheitert der Start mit klarer Anweisung', async () => {
    const { home, bare } = await projectSetup('ohne-baseline');
    const provider = new MicrosandboxSandboxProvider(providerConfig(home, bare));
    expect(
      provider.start({
        projectId: 'ohne-baseline',
        branchName: 'marco/ohne-baseline',
        workspaceDir: workspaceDirFor(home, 'ohne-baseline'),
        templateDir: `fehlt-${crypto.randomUUID().slice(0, 8)}`,
        devCommand: 'bun server.ts',
        previewPort: 5199,
      }),
    ).rejects.toThrow(/Baseline/);
  });
});

describe.skipIf(!vmTestsLauffaehig)('Agent-Config-Persistenz (R9, resume über VM-Neustart)', () => {
  test(
    'CLAUDE_CONFIG_DIR liegt auf einem Volume, das einen VM-Neustart übersteht',
    async () => {
      const { home, bare } = await projectSetup('cfg');
      const provider = new MicrosandboxSandboxProvider(providerConfig(home, bare));
      const ctx = {
        projectId: 'cfg',
        branchName: 'marco/cfg',
        workspaceDir: workspaceDirFor(home, 'cfg'),
        templateDir: FIXTURE_TEMPLATE_DIR,
        devCommand: 'bun server.ts',
        previewPort: 5199,
      };

      // 1. Start: Marker in die Agent-Config schreiben (simuliert eine Session-Datei).
      const h1 = await provider.start(ctx);
      activeHandle = h1;
      await execShell('macvibes-cfg', `echo sess-123 > ${AGENT_CONFIG_GUEST_DIR}/session-marker`);
      await h1.stop();
      activeHandle = null;

      // 2. Neustart: frische VM (Fork aus Baseline) — der Marker muss noch da sein.
      const h2 = await provider.start(ctx);
      activeHandle = h2;
      const marker = await execShell(
        'macvibes-cfg',
        `cat ${AGENT_CONFIG_GUEST_DIR}/session-marker 2>/dev/null || echo FEHLT`,
      );
      expect(marker.trim()).toBe('sess-123');

      await h2.stop();
      activeHandle = null;
    },
    { timeout: 180_000 },
  );
});

describe.skipIf(!vmTestsLauffaehig)(
  'Delta-Install (ADR 0002: bun add überlebt VM-Neustart)',
  () => {
    test(
      'ein per bun add installiertes Paket ist nach dem Neustart wieder importierbar',
      async () => {
        const { home, bare } = await projectSetup('delta');
        const provider = new MicrosandboxSandboxProvider(providerConfig(home, bare));
        const ctx = {
          projectId: 'delta',
          branchName: 'marco/delta',
          workspaceDir: workspaceDirFor(home, 'delta'),
          templateDir: FIXTURE_TEMPLATE_DIR,
          devCommand: 'bun server.ts',
          previewPort: 5199,
        };

        // 1. Start: file:-Dependency host-seitig ins Volume legen (kein Netz
        // nötig) und in der VM per bun add installieren.
        const h1 = await provider.start(ctx);
        activeHandle = h1;
        await waitForHttp(`http://localhost:${h1.previewHostPort}/`);
        const vendorDir = join(ctx.workspaceDir, 'vendor', 'mv-testpkg');
        mkdirSync(vendorDir, { recursive: true });
        writeFileSync(
          join(vendorDir, 'package.json'),
          JSON.stringify({ name: 'mv-testpkg', version: '1.0.0', main: 'index.js' }),
        );
        writeFileSync(join(vendorDir, 'index.js'), "module.exports = 'delta-lebt';");
        await execShell('macvibes-delta', 'cd /work && bun add ./vendor/mv-testpkg 2>&1 | tail -1');
        const first = await execShell(
          'macvibes-delta',
          `bun -e "console.log(require('mv-testpkg'))"`,
        );
        expect(first.trim()).toBe('delta-lebt');
        await h1.stop();
        activeHandle = null;

        // 2. Neustart: frischer Fork — der Boot-Delta-Install (devserver-run.sh)
        // muss das Paket aus bun.lock rekonstruieren, BEVOR die Preview ready ist.
        const h2 = await provider.start(ctx);
        activeHandle = h2;
        await waitForHttp(`http://localhost:${h2.previewHostPort}/`);
        const second = await execShell(
          'macvibes-delta',
          `bun -e "console.log(require('mv-testpkg'))"`,
        );
        expect(second.trim()).toBe('delta-lebt');

        // Mechanismus unverändert: node_modules bleibt Symlink in den Fork.
        const stat = lstatSync(join(ctx.workspaceDir, 'node_modules'), { throwIfNoEntry: false });
        expect(stat?.isSymbolicLink()).toBe(true);

        await h2.stop();
        activeHandle = null;
      },
      { timeout: 180_000 },
    );
  },
);

describe.skipIf(!vmTestsLauffaehig)('In-VM-Supervision (R7, Crash-Recovery durch monit)', () => {
  test(
    'stirbt der Dev-Server in der VM, startet monit ihn neu — VM überlebt',
    async () => {
      const { home, bare } = await projectSetup('wd');
      const provider = new MicrosandboxSandboxProvider(providerConfig(home, bare));
      const handle = await provider.start({
        projectId: 'wd',
        branchName: 'marco/wd',
        workspaceDir: workspaceDirFor(home, 'wd'),
        templateDir: FIXTURE_TEMPLATE_DIR,
        devCommand: 'bun server.ts',
        previewPort: 5199,
      });
      activeHandle = handle;
      const url = `http://localhost:${handle.previewHostPort}/`;
      const startsFile = join(workspaceDirFor(home, 'wd'), '.starts');
      const startCount = () =>
        existsSync(startsFile) ? readFileSync(startsFile, 'utf8').trim().split('\n').length : 0;

      // Erstmal läuft die Preview (genau ein Start).
      expect(await waitForHttp(url)).toBe('hallo-preview');
      const before = startCount();
      expect(before).toBe(1);

      // Dev-Server von INNEN crashen (/crash → process.exit(1)): eine
      // msb-exec-Session kann Prozesse im PID-1-Baum nicht killen
      // (eigene PID-Namespaces, Spike-Befund 2026-07-06).
      const crashResponse = await fetch(`${url}crash`, { signal: AbortSignal.timeout(3000) });
      expect(await crashResponse.text()).toBe('crash');

      // monit muss ihn neu starten → Preview wieder erreichbar UND eine
      // zusätzliche Startzeile (= echte neue Instanz, nicht bloß weitergelaufen).
      const start = Date.now();
      while (Date.now() - start < 40_000) {
        if (
          startCount() > before &&
          (await fetch(url, { signal: AbortSignal.timeout(1500) })
            .then((r) => r.ok)
            .catch(() => false))
        )
          break;
        await Bun.sleep(300);
      }
      expect(startCount()).toBeGreaterThan(before);
      expect(await waitForHttp(url, 10_000)).toBe('hallo-preview');

      // Und die VM lebt weiter (msb exec funktioniert = Agent-Umgebung intakt).
      const alive = await execShell('macvibes-wd', 'echo vm-lebt');
      expect(alive).toContain('vm-lebt');

      await handle.stop();
      activeHandle = null;
    },
    { timeout: 120_000 },
  );
});

describe('msbAvailable', () => {
  test('erkennt die installierte msb-CLI', async () => {
    // Auf diesem Entwicklungsrechner ist msb installiert (B5-Voraussetzung).
    expect(await msbAvailable()).toBe(true);
  });
});

/**
 * Schlägt das Bereitwerden fehl, war die VM schon gestartet und ihr
 * Host-Proxy-Token schon ausgestellt. Ohne Aufräumen blieb eine laufende
 * MicroVM mit GÜLTIGEM Token zurück — Credential- und Egress-Proxy standen ihr
 * also weiter offen, obwohl der Start für den Aufrufer gescheitert war.
 */
describe.skipIf(!vmTestsLauffaehig)('Aufräumen nach fehlgeschlagenem Start', () => {
  test(
    'entwertet das Token und stoppt die VM, wenn das Bereitwerden scheitert',
    async () => {
      const { home, bare } = await projectSetup('cleanup-1');
      const basis = providerConfig(home, bare);
      const widerrufen: string[] = [];
      const provider = new MicrosandboxSandboxProvider({
        ...basis,
        agentDaemon: {
          ...basis.agentDaemon,
          revokeToken: (name: string) => {
            widerrufen.push(name);
          },
        },
        waitForReady: async () => {
          throw new Error('Agent-Endpunkt wird nicht bereit (simuliert)');
        },
      });

      await expect(
        provider.start({
          projectId: 'cleanup-1',
          branchName: 'marco/cleanup-1',
          workspaceDir: workspaceDirFor(home, 'cleanup-1'),
          templateDir: FIXTURE_TEMPLATE_DIR,
          devCommand: 'bun server.ts',
          previewPort: 5177,
        }),
      ).rejects.toThrow('Agent-Endpunkt');

      // Token entwertet — sonst öffnete es Credential- und Egress-Proxy weiter.
      expect(widerrufen).toEqual(['macvibes-cleanup-1']);
      // Und die VM läuft nicht mehr.
      const liste = (await listSandboxNames()).join('\n');
      expect(liste).not.toContain('macvibes-cleanup-1');
    },
    { timeout: 120_000 },
  );
});

/**
 * Derselbe Aufräumpfad, aber eine Stufe früher: nicht das Bereitwerden, sondern
 * der VM-Start selbst scheitert (msb-Schemakonflikt, fehlendes Image, OOM).
 *
 * Vorher lag das Aufräumen ausschliesslich im `waitForReady`-Fehlerpfad, ein
 * Wurf aus `startSandbox` ging daran vorbei. Jeder Fehlstart reservierte damit
 * dauerhaft einen Host-Port im providerweiten Allocator UND liess ein gültiges
 * VM-Token stehen — das authentifiziert Credential-Proxy, Egress-Proxy und
 * Agent-Gateway, obwohl die Plattform den Start für gescheitert hält und keinen
 * Handle zum Stoppen besitzt.
 */
describe.skipIf(!vmTestsLauffaehig)('Aufräumen, wenn schon der VM-Start scheitert', () => {
  test('gibt den Host-Port frei und entwertet das Token', async () => {
    const { home, bare } = await projectSetup('cleanup-2');
    const basis = providerConfig(home, bare);
    const widerrufen: string[] = [];
    const freigegeben: number[] = [];

    // Freigaben mitschneiden, ohne das Verhalten zu ändern.
    const ports = new PortAllocator();
    const echteFreigabe = ports.release.bind(ports);
    ports.release = (port: number): void => {
      freigegeben.push(port);
      echteFreigabe(port);
    };

    const provider = new MicrosandboxSandboxProvider({
      ...basis,
      ports,
      agentDaemon: {
        ...basis.agentDaemon,
        revokeToken: (name: string) => {
          widerrufen.push(name);
        },
      },
      // Es startet keine echte VM — der Start wirft, bevor msb etwas tut.
      startSandbox: async () => {
        throw new Error('database schema is newer than this msb binary (simuliert)');
      },
    });

    await expect(
      provider.start({
        projectId: 'cleanup-2',
        branchName: 'marco/cleanup-2',
        workspaceDir: workspaceDirFor(home, 'cleanup-2'),
        templateDir: FIXTURE_TEMPLATE_DIR,
        devCommand: 'bun server.ts',
        previewPort: 5178,
      }),
    ).rejects.toThrow('database schema is newer');

    // Ohne Widerruf bliebe das Token für Credential- und Egress-Proxy gültig.
    expect(widerrufen).toEqual(['macvibes-cleanup-2']);
    // Ohne Freigabe wäre der Port für die Lebensdauer des Prozesses verloren.
    expect(freigegeben).toHaveLength(1);
  });
});

/**
 * Verhalten von `msb run` bei einem bereits belegten Sandbox-Namen — geprüft,
 * nicht abgeleitet.
 *
 * Stürzt der Server ab oder wird er hart beendet, laufen seine MicroVMs weiter;
 * der neue Prozess kennt sie nicht. Weil der Sandbox-Name aus der projectId
 * gebildet wird (`macvibes-<projectId>`), liegt die Vermutung nahe, ein solcher
 * Zombie blockiere das erneute Öffnen des Projekts — `start()` räumt nämlich
 * keinen Altbestand ab, sondern ruft direkt `msb run`.
 *
 * Diese Vermutung ist FALSCH, und genau das hält dieser Test fest: msb ersetzt
 * eine vorhandene Sandbox desselben Namens, der Start läuft durch. Es braucht
 * im Provider also kein Vorab-Aufräumen. Wer das ändern will, sollte hier
 * zuerst nachlesen, warum es nicht nötig war.
 */
describe.skipIf(!vmTestsLauffaehig)('Belegter Sandbox-Name (Zombie nach Serverabsturz)', () => {
  test(
    'blockiert den erneuten Start NICHT — msb ersetzt die alte Sandbox',
    async () => {
      const { home, bare } = await projectSetup('zombie-1');
      const context = {
        projectId: 'zombie-1',
        branchName: 'marco/zombie-1',
        workspaceDir: workspaceDirFor(home, 'zombie-1'),
        templateDir: FIXTURE_TEMPLATE_DIR,
        devCommand: 'bun server.ts',
        previewPort: 5188,
      };
      const name = microsandboxSandboxName('zombie-1');

      // Erster Start — die VM läuft.
      const provider1 = new MicrosandboxSandboxProvider(providerConfig(home, bare));
      await provider1.start(context);
      expect(await listSandboxNames()).toContain(name);

      // Kein stop(): die VM bleibt absichtlich stehen. Ein FRISCHER Provider
      // steht für den neu gestarteten Serverprozess, der sie nicht kennt.
      const provider2 = new MicrosandboxSandboxProvider(providerConfig(home, bare));
      const handle2 = await provider2.start(context);
      activeHandle = handle2;

      // Der Start geht durch, und es bleibt genau EINE Sandbox dieses Namens.
      const liste = (await listSandboxNames()).join('\n');
      const treffer = liste.split('\n').filter((zeile) => zeile.includes(name));
      expect(treffer).toHaveLength(1);
      expect(handle2.previewHostPort).not.toBeNull();

      // Der Handle des ersten Starts ist damit VERALTET: sein stop() würde die
      // neue Sandbox treffen, weil beide denselben Namen tragen. Nach einem
      // echten Serverabsturz existiert er nicht mehr — ein alter Handle darf
      // aber nie weiterverwendet werden. Deshalb hier absichtlich kein
      // handle1.stop(); aufgeräumt wird über activeHandle (handle2).
    },
    { timeout: 180_000 },
  );
});
