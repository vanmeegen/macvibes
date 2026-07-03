import { createYoga } from 'graphql-yoga';
import { useCookies } from '@whatwg-node/server-plugin-cookies';
import { loadConfig } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { readSessionToken } from './http/cookies';
import { serveWebUi } from './http/staticFiles';
import { ProcessSandboxProvider } from './sandbox/processProvider';
import { SandboxManager } from './sandbox/sandboxManager';
import { schema } from './schema';
import type { GraphQLContext } from './schema/builder';
import { resolveSession } from './services/authService';
import { ensureBareRepo } from './services/gitService';

const config = loadConfig();
const db = createDb(config.dbPath);
runMigrations(db);
await ensureBareRepo(config.bareRepoPath);

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
});

const yoga = createYoga<Record<string, never>, GraphQLContext>({
  schema,
  graphqlEndpoint: '/graphql',
  landingPage: false,
  maskedErrors: false,
  plugins: [useCookies()],
  context: async ({ request }) => {
    const token = await readSessionToken(request);
    const currentUser = token ? await resolveSession(db, config, token) : null;
    return { db, config, currentUser, request, sandboxManager };
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
