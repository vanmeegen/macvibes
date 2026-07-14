import { createYoga } from 'graphql-yoga';
import { useCookies } from '@whatwg-node/server-plugin-cookies';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { createAnthropicProxy } from './http/anthropicProxy';
import { startEgressProxy } from './http/egressProxy';
import { startPreviewGateway } from './http/previewGateway';
import { readSessionToken } from './http/cookies';
import { serveWebUi } from './http/staticFiles';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_GATEWAY_PATH, AgentGateway } from './agent/agentGateway';
import { ClaudeAgentRunner } from './agent/claudeRunner';
import { buildDaemonBundle } from './agent/daemonBundle';
import { DaemonAgentRunner } from './agent/daemonRunner';
import { FakeAgentRunner } from './agent/fakeRunner';
import { buildVmAgentEnv } from './agent/vmAgentEnv';
import {
  MicrosandboxSandboxProvider,
  microsandboxSandboxName,
  msbAvailable,
} from './sandbox/microsandboxProvider';
import { ProcessSandboxProvider } from './sandbox/processProvider';
import { SandboxManager } from './sandbox/sandboxManager';
import { schema } from './schema';
import type { GraphQLContext } from './schema/builder';
import { autoCommit, createTurnEndAutoCommit } from './services/autoCommitService';
import { ensureAdmin, resolveSession } from './services/authService';
import { ChatService } from './services/chatService';
import { ensureBareRepo } from './services/gitService';
import { startMirrorScheduler } from './services/mirrorService';
import { workspaceDirFor } from './services/workspaceService';

const config = loadConfig();
const db = createDb(config.dbPath);
runMigrations(db);
// Bootstrap-Admin (optional per MACVIBES_ADMIN_USERNAME) freischalten/befördern.
await ensureAdmin(db, config);
await ensureBareRepo(config.bareRepoPath);

// Shared Secret VM → Credential-Proxy, pro Serverstart neu (B5c).
// Zufällig pro Start; für kontrollierte Diagnose per Env überschreibbar.
const proxyToken = Bun.env.MACVIBES_PROXY_TOKEN ?? crypto.randomUUID();
// Egress-Proxy: einziger Weg der VMs ins Internet (msb-Regeln blocken Public).
const egressPort = Bun.env.MACVIBES_EGRESS_PORT ? Number(Bun.env.MACVIBES_EGRESS_PORT) : 4010;
const egressProxy = startEgressProxy({ port: egressPort, token: proxyToken });
console.log(`Egress-Proxy für VMs auf Port ${egressProxy.port}`);
const anthropicProxy = createAnthropicProxy({
  upstreamUrl: config.anthropic.upstreamUrl,
  proxyToken,
  oauthToken: config.anthropic.oauthToken,
  apiKey: config.anthropic.apiKey,
  keepAliveMs: Bun.env.MACVIBES_PROXY_KEEPALIVE_MS
    ? Number(Bun.env.MACVIBES_PROXY_KEEPALIVE_MS)
    : undefined,
  // Modell-Routing: claude-* → Anthropic, alles andere → lokaler Router (Shim);
  // Zusatz-Routen (MACVIBES_MODEL_ROUTES) matchen davor.
  localUpstreamUrl: config.localModels.upstreamUrl,
  localApiKey: config.localModels.apiKey,
  extraRoutes: config.modelRoutes,
});
if (config.anthropic.oauthToken === null && config.anthropic.apiKey === null) {
  console.warn(
    'Achtung: keine Claude-Credentials (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) — ' +
      'Claude-Modelle laufen dann über den lokalen Router (Fallback), nur lokale Modelle sind verlässlich.',
  );
}

// chatService entsteht erst nach dem Manager — Hooks greifen über diese Referenz.
let chatServiceRef: ChatService | null = null;

const useMicrosandbox =
  config.sandbox.backend === 'microsandbox' ||
  (config.sandbox.backend === 'auto' && (await msbAvailable()));

// Agent-Transport in die VM: persistenter SDK-Daemon (architektur.md, A+C).
// Gateway für die eingehenden Daemon-Verbindungen + gebündelter Daemon,
// den der Provider read-only in jede VM mountet.
const agentGateway = new AgentGateway({ token: proxyToken });
const daemonBundleDir = join(config.macvibesHome, 'agent-daemon');
if (useMicrosandbox) {
  await buildDaemonBundle(daemonBundleDir);
}

const sandboxProvider = useMicrosandbox
  ? new MicrosandboxSandboxProvider({
      macvibesHome: config.macvibesHome,
      bareRepoPath: config.bareRepoPath,
      image: config.sandbox.image,
      cpus: config.sandbox.cpus,
      memoryMib: config.sandbox.memoryMib,
      agentDaemon: {
        bundleDir: daemonBundleDir,
        envFor: (sandboxName: string) => ({
          ...buildVmAgentEnv({ serverPort: config.port, proxyToken, egressPort }),
          MACVIBES_AGENT_GATEWAY_URL:
            `ws://host.microsandbox.internal:${config.port}${AGENT_GATEWAY_PATH}` +
            `?sandbox=${encodeURIComponent(sandboxName)}&token=${encodeURIComponent(proxyToken)}`,
          MACVIBES_AGENT_CWD: '/work',
        }),
      },
    })
  : new ProcessSandboxProvider({
      macvibesHome: config.macvibesHome,
      bareRepoPath: config.bareRepoPath,
    });
console.log(
  `Sandbox-Backend: ${useMicrosandbox ? `microsandbox (${config.sandbox.image}, ${config.sandbox.cpus} CPUs, ${config.sandbox.memoryMib} MiB)` : 'process (kein VM-Isolat!)'}`,
);

const sandboxManager = new SandboxManager({
  provider: sandboxProvider,
  graceMs: config.sandbox.graceMs,
  idleMs: config.sandbox.idleMs,
  maxSandboxes: config.sandbox.maxSandboxes,
  onStatusChange: (projectId, status) => {
    console.log(`Sandbox ${projectId}: ${status}`);
  },
  // Offenen Stand vor jedem Stopp sichern (R9).
  onBeforeStop: async (projectId) => {
    const workspaceDir = workspaceDirFor(config.macvibesHome, projectId);
    if (!existsSync(join(workspaceDir, '.git'))) return;
    try {
      await autoCommit(workspaceDir, 'Auto-Commit vor Sandbox-Stopp');
    } catch (error) {
      console.error(`Auto-Commit vor Stopp von ${projectId} fehlgeschlagen:`, error);
      await chatServiceRef?.postMessage(
        projectId,
        'error',
        `Auto-Commit vor Sandbox-Stopp fehlgeschlagen: ${String(error)}`,
      );
    }
  },
});

// Preview-Gateway: EIN fester Port, der jede Preview auf ihren dynamischen
// VM-Port reverse-proxied — nur dieser Port muss für Remote-/VPN-Zugriff
// geforwardet werden (die zufälligen hohen VM-Ports kommen nicht durch).
const previewGateway = startPreviewGateway({
  port: config.sandbox.previewGatewayPort,
  hostname: config.hostname,
  previewPortFor: (projectId) => sandboxManager.previewHostPort(projectId),
});
console.log(`Preview-Gateway auf http://${config.hostname}:${previewGateway.port}`);

function selectAgentRunner() {
  if (config.agent.backend === 'fake') {
    console.log('Agent-Backend: fake (MACVIBES_AGENT=fake)');
    return new FakeAgentRunner(config.agent.fakeDelayMs);
  }
  if (useMicrosandbox) {
    // Persistenter SDK-Daemon in der VM, Kommandos über das WS-Gateway —
    // kein msb exec im Agent-Pfad (architektur.md, chatproblems.md).
    console.log('Agent-Backend: claude-Daemon in VM (WS-Gateway, Supervisor: tini+monit)');
    return new DaemonAgentRunner({
      gateway: agentGateway,
      sandboxNameFor: microsandboxSandboxName,
      connectTimeoutMs: 60_000,
    });
  }
  console.log('Agent-Backend: claude als Host-Prozess (kein VM-Isolat!)');
  return new ClaudeAgentRunner();
}

const agentRunner = selectAgentRunner();

const chatService = new ChatService(
  db,
  agentRunner,
  {
    onAgentActivity: (projectId) => sandboxManager.noteAgentActivity(projectId),
    // Auto-Commit nach jedem abgeschlossenen Turn (R8).
    onTurnEnd: (projectId, userPrompt) => {
      if (chatServiceRef === null) return Promise.resolve();
      return createTurnEndAutoCommit({
        macvibesHome: config.macvibesHome,
        chatService: chatServiceRef,
      })(projectId, userPrompt);
    },
  },
  {
    // Reagiert der Agent so lange gar nicht, gilt der Turn als hängend und wird als
    // Fehler sichtbar abgebrochen (statt ewig „Agent arbeitet"). Env-übersteuerbar.
    agentIdleTimeoutMs: Bun.env.MACVIBES_AGENT_IDLE_TIMEOUT_MS
      ? Number(Bun.env.MACVIBES_AGENT_IDLE_TIMEOUT_MS)
      : undefined,
    agentFirstEventTimeoutMs: Bun.env.MACVIBES_AGENT_FIRST_EVENT_TIMEOUT_MS
      ? Number(Bun.env.MACVIBES_AGENT_FIRST_EVENT_TIMEOUT_MS)
      : undefined,
    agentColdStartTimeoutMs: Bun.env.MACVIBES_AGENT_COLD_START_TIMEOUT_MS
      ? Number(Bun.env.MACVIBES_AGENT_COLD_START_TIMEOUT_MS)
      : undefined,
    // Timeouts für LANGSAME (lokale) Modelle — greift pro Turn je nach Projekt-Modell.
    agentSlowIdleTimeoutMs: Bun.env.MACVIBES_AGENT_SLOW_IDLE_TIMEOUT_MS
      ? Number(Bun.env.MACVIBES_AGENT_SLOW_IDLE_TIMEOUT_MS)
      : undefined,
    agentSlowFirstEventTimeoutMs: Bun.env.MACVIBES_AGENT_SLOW_FIRST_EVENT_TIMEOUT_MS
      ? Number(Bun.env.MACVIBES_AGENT_SLOW_FIRST_EVENT_TIMEOUT_MS)
      : undefined,
    agentSlowColdStartTimeoutMs: Bun.env.MACVIBES_AGENT_SLOW_COLD_START_TIMEOUT_MS
      ? Number(Bun.env.MACVIBES_AGENT_SLOW_COLD_START_TIMEOUT_MS)
      : undefined,
    prewarmEnabled: config.agent.prewarm,
  },
);
chatServiceRef = chatService;

const yoga = createYoga<Record<string, never>, GraphQLContext>({
  schema,
  graphqlEndpoint: '/graphql',
  landingPage: false,
  maskedErrors: false,
  plugins: [useCookies()],
  context: async ({ request }) => {
    const token = await readSessionToken(request);
    const currentUser = token ? await resolveSession(db, config, token) : null;
    return { db, config, currentUser, request, sandboxManager, chatService };
  },
});

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  // Bun kappt eingehende Verbindungen sonst nach 10s Idle — das trifft (a) den
  // VM→Host-Proxy-Request, wenn die Claude-API bei großen Aufgaben (langes
  // Thinking) >10s bis zum ersten Byte braucht → der Agent hängt, und (b) die
  // SSE-Chat-Subscription. Maximum (255s) deckt beides großzügig ab.
  idleTimeout: 255,
  // Agent-Gateway: die Daemons in den VMs halten hierüber ihre WS-Verbindung.
  websocket: agentGateway.websocket,
  fetch: async (request, server) => {
    const url = new URL(request.url);
    if (url.pathname === AGENT_GATEWAY_PATH) {
      return agentGateway.handleUpgrade(request, server);
    }
    if (url.pathname === '/graphql') {
      return yoga.fetch(request);
    }
    // Credential-Proxy für den Agenten in der VM (B5c): /anthropic/* → Claude API.
    if (url.pathname.startsWith('/anthropic/')) {
      const upstreamPath = url.pathname.slice('/anthropic'.length) + url.search;
      return anthropicProxy(request, upstreamPath);
    }
    const staticResponse = await serveWebUi(config.webDistDir, url.pathname);
    if (staticResponse) {
      return staticResponse;
    }
    return new Response(
      'macvibes-Server läuft. Web-UI: im Dev-Modus http://localhost:5173, sonst apps/web bauen.',
      { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  },
});

console.log(`macvibes-Server läuft auf http://${server.hostname}:${server.port}`);
console.log(`GraphQL: http://${server.hostname}:${server.port}/graphql`);
console.log(`Bare-Repo: ${config.bareRepoPath}`);

// GitHub-Mirror (Phase C): periodisch spiegeln, falls konfiguriert.
const mirror = startMirrorScheduler(
  { bareRepoPath: config.bareRepoPath, remoteUrl: config.mirror.remoteUrl },
  config.mirror.intervalMs,
);
if (config.mirror.remoteUrl !== null) {
  console.log(`GitHub-Mirror aktiv (alle ${Math.round(config.mirror.intervalMs / 60000)} min)`);
}

// MicroVMs laufen detached — beim Herunterfahren sauber stoppen (inkl. Auto-Commit).
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} empfangen — stoppe alle Sandboxes…`);
  mirror.stop();
  previewGateway.stop();
  try {
    await sandboxManager.stopAll();
  } catch (error) {
    console.error('Fehler beim Stoppen der Sandboxes:', error);
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
