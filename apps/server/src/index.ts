import { homeEnvPathFor, loadConfig, loadHomeEnvFile } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { createAnthropicProxy } from './http/anthropicProxy';
import { createTargetChecker, startEgressProxy } from './http/egressProxy';
import { startPreviewGateway } from './http/previewGateway';
import { createAppYoga } from './http/createAppYoga';
import { serveWebUi } from './http/staticFiles';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AGENT_GATEWAY_PATH, AgentGateway } from './agent/agentGateway';
import { loadUserAgentModels } from './agent/agentModel';
import { ClaudeAgentRunner } from './agent/claudeRunner';
import { buildDaemonBundle } from './agent/daemonBundle';
import { DaemonAgentRunner } from './agent/daemonRunner';
import { FakeAgentRunner } from './agent/fakeRunner';
import { buildVmAgentEnv } from './agent/vmAgentEnv';
import {
  MSB_HOST_ALIAS,
  MicrosandboxSandboxProvider,
  microsandboxSandboxName,
  msbAvailable,
} from './sandbox/microsandboxProvider';
import { touchSandbox } from './sandbox/msbClient';
import { ProcessSandboxProvider } from './sandbox/processProvider';
import { selectBackends, type BackendSelection } from './sandbox/backendSelection';
import { SandboxManager } from './sandbox/sandboxManager';
import { supportsPosixModes } from './core/fsCapabilities';
import { GUEST_WORKDIR } from './core/vmContract';
import { createVmTokenRegistry } from './core/vmTokens';
import { autoCommit, createTurnEndAutoCommit } from './services/autoCommitService';
import { ensureAdmin, purgeExpiredSessions, resolveSession } from './services/authService';
import { ChatService } from './services/chatService';
import { ensureBareRepo } from './core/gitService';
import { startMirrorScheduler } from './services/mirrorService';
import { startLocalRouter } from './services/localRouterService';
import { ShutdownSequence } from './shutdownSequence';
import { FIXED_SHUTDOWN_STEP_TIMEOUTS_MS, sandboxShutdownBudgetMs } from '@macvibes/shared';
import { projectRepoFor } from './core/workspaceService';
import { initHotReload } from './devHotReload';

// Dev-Hot-Reload (`bun --hot`): Bun führt dieses Modul bei jeder Quelldatei-
// Änderung ERNEUT aus, im selben Prozess — die Listener der vorigen Ausführung
// bleiben dabei gebunden. `Bun.serve` tauscht --hot in-place, `Bun.listen`
// (Egress-Proxy) NICHT: der zweite Lauf starb mit EADDRINUSE und riss laufende
// Agent-Turns mit (Live-Befund 2026-07-29). Deshalb hier, VOR jedem Binden,
// die Ressourcen der vorigen Ausführung schliessen; die eigenen werden unten
// per `hot.addCleanup` direkt nach ihrem Entstehen registriert. In Produktion
// (`bun run start`, ohne --hot) ist all das ein No-op — Begründung und
// Mechanik (warum globalThis statt `import.meta.hot`): devHotReload.ts.
const hot = await initHotReload();

// Fall 3 der Vorrangregel: die nutzereigene <macvibesHome>/.env laden, BEVOR die
// Config gelesen wird. Bereits gesetzte Variablen (explizit oder aus der
// cwd-.env, die Bun automatisch lädt) gewinnen — s. loadHomeEnvFile. Der
// Seiteneffekt sitzt hier in der Composition Root, nicht in loadConfig().
loadHomeEnvFile(homeEnvPathFor());
const config = loadConfig();
// Nutzereigene Modelle aus <macvibesHome>/models.json in den Katalog mischen.
// Der Dateizugriff sitzt bewusst HIER (Composition Root, wie loadHomeEnvFile
// darüber) statt beim Modul-Import von agentModel.ts: sonst hinge jeder
// Unit-Test, der den Katalog importiert, vom Nutzer-Home der Maschine ab.
// Kaputte/fehlende Datei warnt nur — der Serverstart darf daran nie scheitern.
const nutzerModelle = loadUserAgentModels(join(config.macvibesHome, 'models.json'));
if (nutzerModelle > 0) {
  console.log(`${nutzerModelle} Nutzer-Modell(e) aus ${join(config.macvibesHome, 'models.json')}`);
}
// Beim Start EINMAL den tatsächlich benutzten DB-Pfad (absolut) loggen: genau
// diese Information fehlte beim Homebrew-Install-Test, als eine frische DB im
// Home statt der Bestandsdaten benutzt wurde — mit dieser Zeile wäre der Fehler
// sofort sichtbar gewesen.
console.log(`SQLite-DB: ${resolve(config.dbPath)}`);
const db = createDb(config.dbPath);
runMigrations(db);
// Bootstrap-Admin (optional per MACVIBES_ADMIN_USERNAME) freischalten/befördern.
await ensureAdmin(db, config);
// Abgelaufene Sessions wegräumen: sie wurden bisher nur beim Zugriff gelöscht,
// was bei einem abgelaufenen Cookie nie passiert — entsprechend sammelten sie
// sich an. Einmal beim Start reicht bei 3-Tage-TTL.
const entfernteSessions = await purgeExpiredSessions(db);
if (entfernteSessions > 0) {
  console.log(`${entfernteSessions} abgelaufene Session(s) aufgeräumt`);
}
await ensureBareRepo(config.bareRepoPath);

// Ein Token PRO SANDBOX statt eines Shared Secrets (F4/F12): Credential-Proxy,
// Egress-Proxy und Agent-Gateway prüfen alle gegen dieselbe Registry, aber
// jedes Token gehört genau einer VM und wird beim Stoppen entwertet.
// Beim Hot-Reload wird die Registry ÜBERNOMMEN statt neu erzeugt: die Daemons
// der weiterlaufenden VMs verbinden sich nach dem Reload mit ihrem alten Token
// neu — eine leere Registry sperrte sie dauerhaft aus allen drei Prüfstellen aus.
const vmTokens = hot.inherited.vmTokens ?? createVmTokenRegistry();
hot.handOver.vmTokens = vmTokens;
// Egress-Proxy: einziger Weg der VMs ins Internet (msb-Regeln blocken Public).
const egressPort = config.egress.port;
const egressProxy = startEgressProxy({
  port: egressPort,
  verifyToken: (token) => vmTokens.lookup(token),
  // Zielprüfung (F3) mit den zentral geparsten Zielports (M6) — dieselbe
  // Policy-Mechanik wie zuvor, nur die Env-Quelle ist jetzt config.ts.
  checkTarget: createTargetChecker({ allowedPorts: config.egress.allowedPorts }),
});
// Bun.listen überlebt keinen Hot-Reload-Tausch (anders als Bun.serve): genau
// dieser Listener war die EADDRINUSE-Quelle des Vorfalls — als Erstes registriert.
hot.addCleanup('Egress-Proxy', () => egressProxy.stop());
console.log(`Egress-Proxy für VMs auf Port ${egressProxy.port}`);
const anthropicProxy = createAnthropicProxy({
  upstreamUrl: config.anthropic.upstreamUrl,
  verifyToken: (token) => vmTokens.lookup(token),
  oauthToken: config.anthropic.oauthToken,
  apiKey: config.anthropic.apiKey,
  keepAliveMs: config.anthropic.keepAliveMs,
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

// EIN Handler-Paar für den gesamten Prozess. Abschaltschritte werden
// registriert, während der Server hochfährt, und laufen beim Signal rückwärts
// ab (zuletzt Gestartetes zuerst gestoppt). Die Registrierung steht bewusst so
// früh, dass auch ein Ctrl-C MITTEN im Hochlauf noch geordnet abräumt — der
// erste Router-Start kann Minuten dauern (venv + LiteLLM).
const shutdownSequence = new ShutdownSequence();
// Handler-Referenzen behalten: beim Hot-Reload trägt die nächste Ausführung
// genau dieses Paar wieder aus (process.off), damit immer nur EINE — die
// jüngste — ShutdownSequence auf Signale reagiert. Sonst summierten sich pro
// Reload Handler auf, und ein Ctrl-C liesse mehrere Sequenzen parallel laufen
// (inkl. doppeltem stopAll/Auto-Commit).
const signalHandlers = (['SIGINT', 'SIGTERM'] as const).map(
  (signal) => [signal, (): void => void shutdownSequence.handle(signal)] as const,
);
for (const [signal, handler] of signalHandlers) {
  process.on(signal, handler);
}
hot.addCleanup('Signal-Handler', () => {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
});

// Lokalen Modell-Router (Anthropic-Shim) MITSTARTEN — im Hintergrund, damit der
// Server sofort hochkommt; qwen-Turns vor Router-Readiness scheitern mit klarer
// 502 des Proxys. Ein extern laufender Shim wird erkannt und nie angefasst.
// Im Fake-Agent-Modus (Tests/E2E) gibt es keine Modell-Requests → kein Autostart.
// Beim Hot-Reload wird ein selbst gestarteter Router ÜBERNOMMEN statt neu
// gestartet: der Prozess soll Reloads überleben (Kaltstart dauert Minuten),
// und ohne Übergabe stufte die neue Ausführung ihn als „extern" ein — ihr
// Shutdown-Schritt wäre ein No-op und `bun run shutdown` liesse den Shim als
// Waise zurück. Der ProcessSupervisor der Startausführung überwacht ihn weiter.
const localRouterReady =
  hot.inherited.localRouter ??
  (config.agent.backend === 'claude'
    ? startLocalRouter({
        upstreamUrl: config.localModels.upstreamUrl,
        command: config.localModels.routerCommand,
        logFile: join(config.macvibesHome, 'local-router.log'),
      })
    : Promise.resolve({ state: 'unavailable' as const, stop: async () => {} }));
hot.handOver.localRouter = localRouterReady;
// Selbst gestarteten Shim beim Beenden mitnehmen (SIGTERM = bun run shutdown).
// Als Schritt, NICHT als eigener Handler: ein zweiter Handler mit eigenem
// process.exit(0) hat vorher den Auto-Commit der Sandboxes abgeschnitten.
// Fristen pro Schritt aus EINER Quelle (@macvibes/shared), damit sie mit der
// Grace des Shutdown-Skripts (scripts/shutdown.ts) im Verhältnis bleiben.
shutdownSequence.register(
  'lokaler Modell-Router',
  async () => {
    const router = await localRouterReady;
    await router.stop();
  },
  FIXED_SHUTDOWN_STEP_TIMEOUTS_MS['lokaler Modell-Router'],
);

/** Meldet eine group/other-lesbare .env — dort steht der Claude-Token (F26). */
function warnIfEnvFileReadable(envPath: string): void {
  if (!existsSync(envPath)) return;
  try {
    // Feature-Detection (P5): ohne durchsetzbare POSIX-Modes wäre der
    // Mode-Check immer „lesbar" und der chmod-Rat sinnlos — stattdessen
    // EINE ehrliche Warnung über die dokumentierte Abschwächung.
    if (!supportsPosixModes(dirname(envPath))) {
      console.warn(
        `WARNUNG: Das Dateisystem von ${envPath} setzt keine POSIX-Dateirechte ` +
          `durch — die Datei (enthält den Claude-Token) ist für andere lokale ` +
          `Konten dieses Rechners lesbar (F26 abgeschwächt).`,
      );
      return;
    }
    if ((statSync(envPath).mode & 0o077) !== 0) {
      console.warn(
        `WARNUNG: ${envPath} ist auch für andere lokale Konten lesbar und enthält ` +
          `den Claude-Token. Bitte "chmod 600 ${envPath}" ausführen.`,
      );
    }
  } catch {
    // Rechte nicht ermittelbar — kein Grund, den Start zu stören.
  }
}

// chatService entsteht erst nach dem Manager — Hooks greifen über diese Referenz.
let chatServiceRef: ChatService | null = null;

// Fail-closed (F9): der echte Agent läuft nur in einer MicroVM. Fehlt das
// Isolat, bricht der Start ab, statt still auf den Host-Prozess zu wechseln.
let backends: BackendSelection;
try {
  backends = selectBackends({
    configured: config.sandbox.backend,
    agent: config.agent.backend,
    msbAvailable: await msbAvailable(),
    allowHostAgent: config.agent.allowHostAgent,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const useMicrosandbox = backends.sandbox === 'microsandbox';

// Agent-Transport in die VM: persistenter SDK-Daemon (architektur.md, A+C).
// Gateway für die eingehenden Daemon-Verbindungen + gebündelter Daemon,
// den der Provider read-only in jede VM mountet.
const agentGateway = new AgentGateway({ tokens: vmTokens });
const daemonBundleDir = join(config.macvibesHome, 'agent-daemon');
if (useMicrosandbox) {
  await buildDaemonBundle(daemonBundleDir);
}

/**
 * Wie weit die Idle-Frist der VM hinter dem host-seitigen Idle-Timer liegt
 * (ADR 0003). Im Normalbetrieb greift damit immer zuerst macvibes' eigene
 * Logik; die VM-Frist feuert nur, wenn dieser Prozess nicht mehr da ist.
 */
const VM_IDLE_MARGIN_MS = 15 * 60 * 1000;

const sandboxProvider = useMicrosandbox
  ? new MicrosandboxSandboxProvider({
      macvibesHome: config.macvibesHome,
      bareRepoPath: config.bareRepoPath,
      image: config.sandbox.image,
      cpus: config.sandbox.cpus,
      memoryMib: config.sandbox.memoryMib,
      // ADR 0003: Auffangnetz für den Fall, dass dieser Prozess stirbt und
      // niemand mehr die Frist zurücksetzt. Abgeleitet statt eigener Parameter,
      // damit die VM-Frist immer hinter dem host-seitigen Idle-Timer liegt.
      vmIdleTimeoutSecs: Math.round((config.sandbox.idleMs + VM_IDLE_MARGIN_MS) / 1000),
      agentDaemon: {
        bundleDir: daemonBundleDir,
        revokeToken: (sandboxName: string) => vmTokens.revoke(sandboxName),
        envFor: (sandboxName: string) => {
          // Frisches Token pro VM-Start; ein älteres derselben Sandbox
          // verfällt dabei automatisch (F12).
          const vmToken = vmTokens.mint(sandboxName);
          // MSB_HOST_ALIAS wird hier injiziert (wie sandboxNameFor beim
          // Runner): der Weg VM→Host ist msb-Topologie — ein anderes
          // VM-Backend reicht seinen eigenen Alias herein.
          return {
            ...buildVmAgentEnv({
              serverPort: config.port,
              proxyToken: vmToken,
              egressPort,
              hostAlias: MSB_HOST_ALIAS,
            }),
            MACVIBES_AGENT_GATEWAY_URL:
              `ws://${MSB_HOST_ALIAS}:${config.port}${AGENT_GATEWAY_PATH}` +
              `?sandbox=${encodeURIComponent(sandboxName)}&token=${encodeURIComponent(vmToken)}`,
            MACVIBES_AGENT_CWD: GUEST_WORKDIR,
          };
        },
      },
      // Preview-Status kommt als Push über die Daemon-Verbindung (ADR 0001).
      subscribePreviewStatus: (sandbox, listener) =>
        agentGateway.subscribe(sandbox, (notification) => {
          if (notification.kind === 'message' && notification.message.kind === 'preview-status') {
            listener(notification.message.status);
          }
        }),
    })
  : new ProcessSandboxProvider({
      macvibesHome: config.macvibesHome,
      bareRepoPath: config.bareRepoPath,
    });
console.log(
  `Sandbox-Backend: ${useMicrosandbox ? `microsandbox (${config.sandbox.image}, ${config.sandbox.cpus} CPUs, ${config.sandbox.memoryMib} MiB)` : 'process (kein VM-Isolat!)'}`,
);

// Offenen Workspace-Stand per Auto-Commit sichern — vor jedem Stopp (R9) und
// vor jedem Frischstart (N7: msb-.replace() überbootet eine nach Hot-Reload
// verwaiste VM ohne stop(), also ohne den Stopp-Hook).
const sichereProjektStand = async (projectId: string, anlass: string): Promise<void> => {
  // Kriterium ist das gitDir NEBEN dem Arbeitsbaum (F1) — ein `.git` im
  // Arbeitsbaum wäre gast-geschrieben und damit kein Beleg für ein Repo.
  const repo = projectRepoFor(config.macvibesHome, projectId);
  if (!existsSync(join(repo.gitDir, 'HEAD'))) return;
  try {
    await autoCommit(repo, anlass);
  } catch (error) {
    console.error(`${anlass} für ${projectId} fehlgeschlagen:`, error);
    await chatServiceRef?.postMessage(
      projectId,
      'error',
      `${anlass} fehlgeschlagen: ${String(error)}`,
    );
  }
};

const sandboxManager = new SandboxManager({
  provider: sandboxProvider,
  graceMs: config.sandbox.graceMs,
  idleMs: config.sandbox.idleMs,
  maxSandboxes: config.sandbox.maxSandboxes,
  // ADR 0003: Jeder host-seitige touch() hält auch die VM-Frist offen —
  // gedrosselt, weil das im Pfad jedes Agent-Events liegt.
  ...(useMicrosandbox
    ? { touchSandbox: (projectId: string) => touchSandbox(microsandboxSandboxName(projectId)) }
    : {}),
  onStatusChange: (projectId, status) => {
    console.log(`Sandbox ${projectId}: ${status}`);
  },
  // Grace-Stopp aufschieben, solange die Sandbox belegt ist (echter Turn ODER
  // Config-Warmup) — lange (z. B. lokale qwen-)Turns überleben so das
  // Zurücknavigieren zur Projektliste. Bewusst isBusy, nicht isTurnActive:
  // Letzteres ist das UI-Vokabular („Agent arbeitet") und zählt den Warmup
  // absichtlich nicht mit.
  isBusy: (projectId) => chatServiceRef?.isBusy(projectId) ?? false,
  // Offenen Stand vor jedem Stopp sichern (R9).
  onBeforeStop: (projectId) => sichereProjektStand(projectId, 'Auto-Commit vor Sandbox-Stopp'),
  // … und vor jedem Frischstart (N7, verwaiste VM nach Hot-Reload): bei leerem
  // git status ein No-op, der Normalfall kostet ein git status.
  onBeforeStart: (projectId) =>
    sichereProjektStand(projectId, 'Auto-Commit vor Sandbox-Start (verwaister Stand?)'),
});
// Beim Hot-Reload nur die Timer entschärfen — KEIN stopAll(): laufende
// MicroVMs (samt Auto-Commit-Hook) bleiben unangetastet, sonst würde ein
// verwaister Grace-/Idle-Timer der alten Ausführung später VMs stoppen,
// während die neue Ausführung sie längst anders verwaltet (s. detachForReload).
hot.addCleanup('Sandbox-Timer', () => sandboxManager.detachForReload());

// Preview-Gateway: EIN fester Port, der jede Preview auf ihren dynamischen
// VM-Port reverse-proxied — nur dieser Port muss für Remote-/VPN-Zugriff
// geforwardet werden (die zufälligen hohen VM-Ports kommen nicht durch).
const previewGateway = startPreviewGateway({
  port: config.sandbox.previewGatewayPort,
  hostname: config.hostname,
  previewPortFor: (projectId) => sandboxManager.previewHostPort(projectId),
  // Previews sind nur für angemeldete Nutzer sichtbar (F19). Ownership wird
  // bewusst NICHT geprüft — fremde Projekte dürfen live betrachtet werden
  // (R10), genau wie beim Chat-Verlauf.
  authenticate: async (token) =>
    token !== null && (await resolveSession(db, config, token)) !== null,
});
hot.addCleanup('Preview-Gateway', () => previewGateway.stop());
console.log(`Preview-Gateway auf http://${config.hostname}:${previewGateway.port}`);

function selectAgentRunner() {
  if (backends.agent === 'fake') {
    console.log('Agent-Backend: fake (MACVIBES_AGENT=fake)');
    return new FakeAgentRunner(config.agent.fakeDelayMs);
  }
  if (backends.agent === 'daemon') {
    // Persistenter SDK-Daemon in der VM, Kommandos über das WS-Gateway —
    // kein msb exec im Agent-Pfad (architektur.md, chatproblems.md).
    console.log('Agent-Backend: claude-Daemon in VM (WS-Gateway, Supervisor: tini+monit)');
    return new DaemonAgentRunner({
      gateway: agentGateway,
      sandboxNameFor: microsandboxSandboxName,
      connectTimeoutMs: 60_000,
    });
  }
  console.warn(
    'Agent-Backend: claude als HOST-PROZESS ohne VM-Isolat — ' +
      'nur wegen MACVIBES_ALLOW_HOST_AGENT=1. Der Agent hat damit die Rechte des Server-Nutzers.',
  );
  return new ClaudeAgentRunner({ appendSystemPrompt: config.agent.appendSystemPrompt });
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
    // Reagiert der Agent so lange gar nicht, gilt der Turn als hängend und wird
    // als Fehler sichtbar abgebrochen (statt ewig „Agent arbeitet"). Über die
    // Config env-übersteuerbar (MACVIBES_AGENT_*_TIMEOUT_MS, M6); die slow*-
    // Fristen greifen pro Turn bei LANGSAMEN (lokalen) Modellen, die warmup-
    // Frist deckt den stillen Config-Warmup ab, auf den der erste echte Turn
    // wartet, bevor sein eigener Timeout greift.
    agentIdleTimeoutMs: config.agent.timeouts.idleMs,
    agentFirstEventTimeoutMs: config.agent.timeouts.firstEventMs,
    agentColdStartTimeoutMs: config.agent.timeouts.coldStartMs,
    agentWarmupTimeoutMs: config.agent.timeouts.warmupMs,
    agentSlowIdleTimeoutMs: config.agent.timeouts.slowIdleMs,
    agentSlowFirstEventTimeoutMs: config.agent.timeouts.slowFirstEventMs,
    agentSlowColdStartTimeoutMs: config.agent.timeouts.slowColdStartMs,
    prewarmEnabled: config.agent.prewarm,
  },
);
chatServiceRef = chatService;

// devWebPort (F5) zieht createAppYoga selbst aus dem config-Objekt — wie
// allowedOrigins; Begründung dort am allowedOrigins-Aufruf.
const yoga = createAppYoga({ db, config, sandboxManager, chatService });

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
      // Client-IP in den Server-Context — Grundlage fürs Rate-Limit (F14).
      return yoga.fetch(request, { ip: server.requestIP(request)?.address ?? null });
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
// stop(true) kappt auch die Gateway-WebSockets der Daemons SAUBER (Close-Frame
// statt hängender halbtoter Verbindung): die Daemons in den weiterlaufenden
// VMs reconnecten mit Backoff (0,5–10 s) und altem Token an die neue Ausführung.
hot.addCleanup('Haupt-Server', async () => {
  await server.stop(true);
});

// F26: Die .env trägt den Claude-Token im Klartext. Nicht automatisch
// korrigieren (es ist eine Nutzerdatei), aber unübersehbar melden — und zwar
// für die TATSÄCHLICH verwendeten Dateien: die cwd-.env, die Bun automatisch
// lädt (im Repo apps/server/.env), UND die explizit geladene
// <macvibesHome>/.env (Fall 3 der Vorrangregel). Doppelte Pfade nur einmal.
for (const envFile of new Set([resolve('.env'), join(config.macvibesHome, '.env')])) {
  warnIfEnvFileReadable(envFile);
}

console.log(`macvibes-Server läuft auf http://${server.hostname}:${server.port}`);
console.log(`GraphQL: http://${server.hostname}:${server.port}/graphql`);
console.log(`Bare-Repo: ${config.bareRepoPath}`);

// GitHub-Mirror (Phase C): periodisch spiegeln, falls konfiguriert.
const mirror = startMirrorScheduler(
  { bareRepoPath: config.bareRepoPath, remoteUrl: config.mirror.remoteUrl },
  config.mirror.intervalMs,
);
// Ohne diesen Schritt summierte sich pro Reload ein weiteres Mirror-Intervall auf.
hot.addCleanup('GitHub-Mirror-Intervall', () => mirror.stop());
if (config.mirror.remoteUrl !== null) {
  console.log(`GitHub-Mirror aktiv (alle ${Math.round(config.mirror.intervalMs / 60000)} min)`);
}

// MicroVMs laufen detached — beim Herunterfahren sauber stoppen (inkl. Auto-Commit).
// Reihenfolge ergibt sich aus der Registrierung: rückwärts, also Sandboxes
// zuerst (ihr Auto-Commit ist das Empfindlichste), dann Gateway, Mirror und
// zuletzt der Modell-Router.
shutdownSequence.register(
  'GitHub-Mirror',
  () => mirror.stop(),
  FIXED_SHUTDOWN_STEP_TIMEOUTS_MS['GitHub-Mirror'],
);
shutdownSequence.register(
  'Preview-Gateway',
  () => previewGateway.stop(),
  FIXED_SHUTDOWN_STEP_TIMEOUTS_MS['Preview-Gateway'],
);
shutdownSequence.register(
  'Sandboxes (inkl. Auto-Commit)',
  () => sandboxManager.stopAll(),
  // N10: skaliert mit der Flottengröße — stopAll() macht pro VM einen
  // host-seitig seriellen Auto-Commit inkl. git push.
  sandboxShutdownBudgetMs(config.sandbox.maxSandboxes),
);
