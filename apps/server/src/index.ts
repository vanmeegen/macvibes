import { createYoga } from 'graphql-yoga';
import { useCookies } from '@whatwg-node/server-plugin-cookies';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { readSessionToken } from './http/cookies';
import { serveWebUi } from './http/staticFiles';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeAgentRunner } from './agent/claudeRunner';
import { FakeAgentRunner } from './agent/fakeRunner';
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

// chatService entsteht erst nach dem Manager — Hooks greifen über diese Referenz.
let chatServiceRef: ChatService | null = null;

const sandboxManager = new SandboxManager({
  provider: new ProcessSandboxProvider({
    macvibesHome: config.macvibesHome,
    bareRepoPath: config.bareRepoPath,
  }),
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

const agentRunner =
  config.agent.backend === 'fake'
    ? new FakeAgentRunner(config.agent.fakeDelayMs)
    : new ClaudeAgentRunner();
if (config.agent.backend === 'fake') {
  console.log('Agent-Backend: fake (MACVIBES_AGENT=fake)');
}

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
