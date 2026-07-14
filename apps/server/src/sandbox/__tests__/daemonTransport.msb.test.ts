import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { join } from 'node:path';
import { AGENT_GATEWAY_PATH, AgentGateway } from '../../agent/agentGateway';
import type { GatewaySocketData } from '../../agent/agentGateway';
import { buildDaemonBundle } from '../../agent/daemonBundle';
import { DaemonAgentRunner } from '../../agent/daemonRunner';
import type { AgentEvent } from '../../agent/events';
import { buildVmAgentEnv } from '../../agent/vmAgentEnv';
import { createAnthropicProxy } from '../../http/anthropicProxy';
import { startEgressProxy } from '../../http/egressProxy';
import type { EgressProxyHandle } from '../../http/egressProxy';
import {
  createTempDir,
  createTemplatesFixture,
  removeDir,
} from '../../services/__tests__/testUtils';
import { createProjectBranch, ensureBareRepo } from '../../services/gitService';
import { workspaceDirFor } from '../../services/workspaceService';
import { baselineSnapshotName, buildTemplateBaseline, removeSnapshot } from '../baselineService';
import { MicrosandboxSandboxProvider, msbAvailable } from '../microsandboxProvider';
import { runMsb } from '../msb';
import type { SandboxHandle } from '../provider';

/**
 * Integrationstest gegen ECHTES microsandbox für den Daemon-Transport
 * (Spike A+C, architektur.md; chatproblems.md-Empfehlung #3: die CI darf auf
 * dem kritischen Pfad nicht blind bleiben). Bewusst gated — er baut eine
 * Baseline inkl. apt-Installation und dauert mehrere Minuten:
 *
 *   MACVIBES_TEST_MSB=1 bun test daemonTransport.msb
 *
 * Der Turn-/Interrupt-Teil läuft zusätzlich nur mit echten Credentials
 * (CLAUDE_CODE_OAUTH_TOKEN oder ANTHROPIC_API_KEY, z. B. via apps/server/.env).
 */

const enabled = Bun.env.MACVIBES_TEST_MSB === '1' && (await msbAvailable());
const oauthToken = Bun.env.CLAUDE_CODE_OAUTH_TOKEN ?? null;
const apiKey = Bun.env.ANTHROPIC_API_KEY ?? null;
const hasCredentials = oauthToken !== null || apiKey !== null;

const PROJECT_ID = 'daemon-spike';
const SANDBOX_NAME = `macvibes-${PROJECT_ID}`;
const TOKEN = crypto.randomUUID();

const tempDirs: string[] = [];
let templateDir = '';
let server: Server<GatewaySocketData> | null = null;
let egress: EgressProxyHandle | null = null;
let gateway: AgentGateway;
let handle: SandboxHandle | null = null;
let runner: DaemonAgentRunner;

async function collectTurn(
  events: AsyncIterable<AgentEvent>,
  maxMs = 180_000,
): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  const deadline = Date.now() + maxMs;
  const iterator = events[Symbol.asyncIterator]();
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      all.push({ type: 'error', message: 'Test: Timeout beim Event-Sammeln (Turn hängt)' });
      break;
    }
    const result = await Promise.race([
      iterator.next(),
      Bun.sleep(remaining).then(() => 'timeout' as const),
    ]);
    if (result === 'timeout') {
      all.push({ type: 'error', message: 'Test: Timeout beim Event-Sammeln (Turn hängt)' });
      break;
    }
    if (result.done) break;
    all.push(result.value);
  }
  return all;
}

beforeAll(async () => {
  if (!enabled) return;

  // Host-Seite: Gateway + Credential-Proxy auf EINEM Server (wie index.ts),
  // dazu der Egress-Proxy — ohne ihn hängt claudes Startup (chatproblems #9).
  gateway = new AgentGateway({ token: TOKEN });
  const anthropicProxy = createAnthropicProxy({
    upstreamUrl: Bun.env.ANTHROPIC_UPSTREAM_URL ?? 'https://api.anthropic.com',
    proxyToken: TOKEN,
    oauthToken,
    apiKey,
  });
  server = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    idleTimeout: 255,
    websocket: gateway.websocket,
    fetch: (request, srv) => {
      const url = new URL(request.url);
      if (url.pathname === AGENT_GATEWAY_PATH) {
        const response = gateway.handleUpgrade(request, srv);
        return response ?? undefined;
      }
      if (url.pathname.startsWith('/anthropic/')) {
        return anthropicProxy(request, url.pathname.slice('/anthropic'.length) + url.search);
      }
      return new Response('nicht hier', { status: 404 });
    },
  });
  egress = startEgressProxy({ port: 0, token: TOKEN });

  // Projekt + Baseline (MIT Daemon-Zubehör: SDK, tini, monit).
  const home = await createTempDir('macvibes-home-');
  tempDirs.push(home);
  templateDir = `daemontest-${crypto.randomUUID().slice(0, 8)}`;
  const templates = await createTemplatesFixture(templateDir);
  tempDirs.push(templates);
  const bare = join(home, 'macvibes-apps.git');
  await ensureBareRepo(bare);
  await createProjectBranch(bare, `marco/${PROJECT_ID}`, join(templates, templateDir));
  await buildTemplateBaseline({ templatesDir: templates, templateDir, image: 'oven/bun' });

  const bundleDir = join(home, 'agent-daemon');
  await buildDaemonBundle(bundleDir);

  const serverPort = server.port;
  if (serverPort === undefined) throw new Error('Testserver ohne Port');
  const egressPort = egress.port;
  const provider = new MicrosandboxSandboxProvider({
    macvibesHome: home,
    bareRepoPath: bare,
    image: 'oven/bun',
    cpus: 2,
    memoryMib: 1024,
    agentDaemon: {
      bundleDir,
      envFor: (sandboxName) => ({
        ...buildVmAgentEnv({ serverPort, proxyToken: TOKEN, egressPort }),
        MACVIBES_AGENT_GATEWAY_URL:
          `ws://host.microsandbox.internal:${serverPort}${AGENT_GATEWAY_PATH}` +
          `?sandbox=${encodeURIComponent(sandboxName)}&token=${encodeURIComponent(TOKEN)}`,
        MACVIBES_AGENT_CWD: '/work',
      }),
    },
  });

  handle = await provider.start({
    projectId: PROJECT_ID,
    branchName: `marco/${PROJECT_ID}`,
    workspaceDir: workspaceDirFor(home, PROJECT_ID),
    templateDir,
    devCommand: 'bun server.ts',
    previewPort: 5199,
  });

  runner = new DaemonAgentRunner({
    gateway,
    sandboxNameFor: () => SANDBOX_NAME,
    connectTimeoutMs: 120_000,
  });
}, 900_000);

afterAll(async () => {
  await handle?.stop();
  server?.stop(true);
  egress?.stop();
  if (templateDir.length > 0) {
    await removeSnapshot(baselineSnapshotName(templateDir));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await removeDir(dir);
  }
});

describe.skipIf(!enabled)(
  'Agent-Daemon-Transport (Spike A+C, echte MicroVM, monit als PID 1)',
  () => {
    test(
      'Daemon wählt sich beim Gateway ein; monit bringt den Dev-Server hoch',
      async () => {
        // Der Daemon verbindet sich AUSGEHEND — das beweist zugleich, dass das
        // Bundle lädt und das Agent SDK im Snapshot auflösbar ist.
        await gateway.waitForConnection(SANDBOX_NAME, 120_000);
        expect(gateway.isConnected(SANDBOX_NAME)).toBe(true);

        // Dev-Server läuft unter monit (nicht mehr unterm Host-Watchdog).
        const url = `http://localhost:${handle!.previewHostPort}/`;
        const start = Date.now();
        let body = '';
        while (Date.now() - start < 120_000) {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (response.ok) {
              body = await response.text();
              break;
            }
          } catch {
            // bootet noch
          }
          await Bun.sleep(500);
        }
        expect(body).toBe('hallo-preview');

        // Der Status-Poller (monit-HTTP-API) meldet den Dev-Server als ready.
        const statusStart = Date.now();
        while (handle!.previewStatus() !== 'ready' && Date.now() - statusStart < 60_000) {
          await Bun.sleep(500);
        }
        expect(handle!.previewStatus()).toBe('ready');
      },
      { timeout: 300_000 },
    );

    test(
      'stirbt der Daemon, startet monit ihn neu und er verbindet sich wieder',
      async () => {
        await gateway.waitForConnection(SANDBOX_NAME, 120_000);

        const readPid = async (): Promise<string> =>
          (
            await runMsb([
              'exec',
              SANDBOX_NAME,
              '--',
              'sh',
              '-c',
              'cat /run/macvibes/agent-daemon.pid 2>/dev/null || echo leer',
            ])
          ).trim();
        const pidVorher = await readPid();
        expect(pidVorher).not.toBe('leer');

        // Daemon beenden — per shutdown-Kommando über die stehende Verbindung.
        // Von außen geht es nicht: msb-exec-Sessions leben in eigenen
        // PID-Namespaces und können den PID-1-Baum nicht killen (Live-Befund;
        // deckt sich mit chatproblems.md „PID-Files nutzlos").
        expect(gateway.send(SANDBOX_NAME, { kind: 'shutdown' })).toBe(true);

        // monit startet neu (2s-Zyklus) — der Restart ist oft SCHNELLER als die
        // beobachtbare Trennung (die neue Verbindung ersetzt die alte im
        // Gateway, bevor der Drop durchschlägt). Beweis ist daher der
        // PID-Wechsel im Pidfile, nicht ein sichtbarer Disconnect.
        const restartStart = Date.now();
        let pidNachher = pidVorher;
        while (Date.now() - restartStart < 90_000) {
          pidNachher = await readPid();
          if (pidNachher !== 'leer' && pidNachher !== pidVorher) break;
          await Bun.sleep(1000);
        }

        // Diagnose bei Fehlschlag: Logs aus der VM sind die einzige Wahrheit.
        if (pidNachher === pidVorher) {
          const dump = async (datei: string): Promise<void> => {
            const inhalt = await runMsb([
              'exec',
              SANDBOX_NAME,
              '--',
              'sh',
              '-c',
              `tail -40 ${datei} 2>/dev/null || echo "(fehlt: ${datei})"`,
            ]).catch((e) => `Dump fehlgeschlagen: ${String(e)}`);
            console.log(`--- ${datei} ---\n${inhalt}`);
          };
          await dump('/var/log/macvibes-agent-daemon.log');
          await dump('/var/log/monit.log');
        }
        expect(pidNachher).not.toBe(pidVorher);

        // … und der neue Daemon hängt wieder am Gateway, ohne Host-Zutun.
        await gateway.waitForConnection(SANDBOX_NAME, 90_000);
        expect(gateway.isConnected(SANDBOX_NAME)).toBe(true);
      },
      { timeout: 200_000 },
    );

    test.skipIf(!hasCredentials)(
      'Turn über den Daemon streamt; Interrupt heilt sich; Folge-Turn behält den Kontext',
      async () => {
        await gateway.waitForConnection(SANDBOX_NAME, 120_000);

        // Turn 1: normaler Durchlauf bis turn-completed inkl. Session-ID.
        // Versuch 1 darf an einer halbtoten Verbindung scheitern (Daemon-
        // Neustart aus dem vorigen Test; msb-NAT verschluckt FIN) — Versuch 2
        // spiegelt exakt den Auto-Retry des chatService.
        const startTurn1 = () =>
          collectTurn(
            runner.startTurn({
              projectId: PROJECT_ID,
              prompt: 'Antworte ausschließlich mit dem Wort: bereit. Merke dir die Zahl 42.',
              workspaceDir: '/egal-host-pfad',
              resumeSessionId: null,
              model: 'claude-sonnet-5',
            }).events,
          );
        let turn1 = await startTurn1();
        if (turn1.at(-1)?.type !== 'turn-completed') {
          console.log('Turn 1, Versuch 1 (erwartbar nach Daemon-Neustart):', JSON.stringify(turn1));
          await gateway.waitForConnection(SANDBOX_NAME, 60_000);
          turn1 = await startTurn1();
        }
        const completed = turn1.at(-1);
        if (completed?.type !== 'turn-completed') {
          console.log('Turn 1 scheiterte — Events:', JSON.stringify(turn1, null, 2));
          const daemonLog = await runMsb([
            'exec',
            SANDBOX_NAME,
            '--',
            'sh',
            '-c',
            'tail -40 /var/log/macvibes-agent-daemon.log 2>/dev/null || echo kein-log',
          ]).catch((e) => `Dump fehlgeschlagen: ${String(e)}`);
          console.log('--- agent-daemon.log ---\n' + daemonLog);
        }
        expect(completed?.type).toBe('turn-completed');
        const text = turn1
          .filter((e): e is Extract<AgentEvent, { type: 'text-delta' }> => e.type === 'text-delta')
          .map((e) => e.text)
          .join('');
        expect(text.toLowerCase()).toContain('bereit');

        // Turn 2: unterbrechen — das war der Deadlock aus chatproblems.md #13.
        const handle2 = runner.startTurn({
          projectId: PROJECT_ID,
          prompt: 'Zähle langsam und ausführlich von 1 bis 100, jede Zahl einzeln erklärt.',
          workspaceDir: '/egal-host-pfad',
          resumeSessionId: null,
          model: 'claude-sonnet-5',
        });
        const turn2Promise = collectTurn(handle2.events);
        // Auf das erste Lebenszeichen warten, dann abbrechen.
        await Bun.sleep(4000);
        handle2.abort();
        const turn2 = await turn2Promise;
        expect(turn2.at(-1)).toEqual({ type: 'turn-aborted' });

        // Turn 3: MUSS sofort funktionieren (kein Hänger, Session lebt weiter)
        // und den Kontext aus Turn 1/2 kennen (dieselbe SDK-Session).
        const turn3 = await collectTurn(
          runner.startTurn({
            projectId: PROJECT_ID,
            prompt:
              'Welche Zahl solltest du dir vorhin merken? Antworte ausschließlich mit der Zahl.',
            workspaceDir: '/egal-host-pfad',
            resumeSessionId: null,
            model: 'claude-sonnet-5',
          }).events,
        );
        expect(turn3.at(-1)?.type).toBe('turn-completed');
        const antwort = turn3
          .filter((e): e is Extract<AgentEvent, { type: 'text-delta' }> => e.type === 'text-delta')
          .map((e) => e.text)
          .join('');
        expect(antwort).toContain('42');
      },
      { timeout: 600_000 },
    );
  },
);
