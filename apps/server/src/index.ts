import { createYoga } from 'graphql-yoga';
import { useCookies } from '@whatwg-node/server-plugin-cookies';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { createAnthropicProxy, PROXY_TOKEN_HEADER } from './http/anthropicProxy';
import { readSessionToken } from './http/cookies';
import { serveWebUi } from './http/staticFiles';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAgentRunner } from './agent/claudeRunner';
import { FakeAgentRunner } from './agent/fakeRunner';
import { msbExecSpawner } from './agent/msbExecSpawner';
import { VmAgentRunner } from './agent/vmRunner';
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
import { resolveSession } from './services/authService';
import { ChatService } from './services/chatService';
import { ensureBareRepo } from './services/gitService';
import { workspaceDirFor } from './services/workspaceService';

const config = loadConfig();
const db = createDb(config.dbPath);
runMigrations(db);
await ensureBareRepo(config.bareRepoPath);

// Shared Secret VM → Credential-Proxy, pro Serverstart neu (B5c).
const proxyToken = crypto.randomUUID();
const anthropicProxy = createAnthropicProxy({
  upstreamUrl: config.anthropic.upstreamUrl,
  proxyToken,
  oauthToken: config.anthropic.oauthToken,
  apiKey: config.anthropic.apiKey,
});
if (config.anthropic.oauthToken === null && config.anthropic.apiKey === null) {
  console.warn(
    'Achtung: keine Claude-Credentials (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) — ' +
      'der Agent in der VM kann die API nicht erreichen.',
  );
}

// chatService entsteht erst nach dem Manager — Hooks greifen über diese Referenz.
let chatServiceRef: ChatService | null = null;

const useMicrosandbox =
  config.sandbox.backend === 'microsandbox' ||
  (config.sandbox.backend === 'auto' && (await msbAvailable()));
const sandboxProvider = useMicrosandbox
  ? new MicrosandboxSandboxProvider({
      macvibesHome: config.macvibesHome,
      bareRepoPath: config.bareRepoPath,
      image: config.sandbox.image,
      cpus: config.sandbox.cpus,
      memoryMib: config.sandbox.memoryMib,
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

function selectAgentRunner() {
  if (config.agent.backend === 'fake') {
    console.log('Agent-Backend: fake (MACVIBES_AGENT=fake)');
    return new FakeAgentRunner(config.agent.fakeDelayMs);
  }
  if (useMicrosandbox) {
    // Agent läuft in der VM (B5c); Credentials nur über den Host-Proxy.
    console.log('Agent-Backend: claude in VM (msb exec, Credential-Proxy)');
    return new VmAgentRunner({
      sandboxNameFor: microsandboxSandboxName,
      agentEnv: () => ({
        // host.microsandbox.internal löst in der VM auf den Host auf (allow@172.16.0.0/12).
        ANTHROPIC_BASE_URL: `http://host.microsandbox.internal:${config.port}/anthropic`,
        // Proxy-Secret als Custom-Header — der Host-Proxy prüft es und ersetzt die Auth.
        ANTHROPIC_CUSTOM_HEADERS: `${PROXY_TOKEN_HEADER}: ${proxyToken}`,
        // Claude Code erwartet einen Token — der echte wird im Proxy ersetzt.
        ANTHROPIC_API_KEY: 'macvibes-proxy',
        // Erlaubt bypassPermissions als root in der VM (wir sind ja isoliert).
        IS_SANDBOX: '1',
      }),
      spawn: msbExecSpawner,
      guestWorkdir: '/work',
    });
  }
  console.log('Agent-Backend: claude als Host-Prozess (kein VM-Isolat!)');
  return new ClaudeAgentRunner();
}

const agentRunner = selectAgentRunner();

const chatService = new ChatService(db, agentRunner, {
  onAgentActivity: (projectId) => sandboxManager.noteAgentActivity(projectId),
  // Auto-Commit nach jedem abgeschlossenen Turn (R8).
  onTurnEnd: (projectId, userPrompt) => {
    if (chatServiceRef === null) return Promise.resolve();
    return createTurnEndAutoCommit({
      macvibesHome: config.macvibesHome,
      chatService: chatServiceRef,
    })(projectId, userPrompt);
  },
});
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
  fetch: async (request) => {
    const url = new URL(request.url);
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

// MicroVMs laufen detached — beim Herunterfahren sauber stoppen (inkl. Auto-Commit).
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} empfangen — stoppe alle Sandboxes…`);
  try {
    await sandboxManager.stopAll();
  } catch (error) {
    console.error('Fehler beim Stoppen der Sandboxes:', error);
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
