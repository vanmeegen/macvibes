import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  port: number;
  hostname: string;
  /** Basis-Verzeichnis für Bare-Repo, Volumes etc. */
  macvibesHome: string;
  /** Lokales Bare-Repo, in dem alle Projekt-Branches leben. */
  bareRepoPath: string;
  /** Ordner mit den Projekt-Templates (templates.json + Unterordner). */
  templatesDir: string;
  /**
   * Optionaler Bootstrap-Admin: dieser Username wird beim Start zum Admin
   * befördert und freigeschaltet. Ohne Wert wird der erste registrierte Nutzer
   * automatisch Admin.
   */
  adminUsername?: string | undefined;
  dbPath: string;
  /** Login-Session: 3 Tage, rollierend verlängert. */
  sessionTtlMs: number;
  /** Gebautes Web-UI (wird ausgeliefert, falls vorhanden). */
  webDistDir: string;
  sandbox: {
    /** Stopp-Verzögerung nach Verlassen der Chat-Page (R9, Default 15 min). */
    graceMs: number;
    /** Stopp nach Agent-Inaktivität (R9, Default 30 min). */
    idleMs: number;
    /** Maximal gleichzeitige Sandboxes (R9, Default 8). */
    maxSandboxes: number;
    /** "auto" nimmt microsandbox, wenn msb installiert ist, sonst Prozess. */
    backend: 'auto' | 'process' | 'microsandbox';
    /** OCI-Image der MicroVMs. */
    image: string;
    cpus: number;
    memoryMib: number;
    /**
     * Fester Port des Preview-Gateways (R7, Remote-/VPN-Zugriff). Alle Previews
     * werden über diesen einen Port reverse-proxied — der Nutzer forwardet nur
     * ihn, statt der zufälligen hohen VM-Ports (Default 4173).
     */
    previewGatewayPort: number;
  };
  agent: {
    /** "claude" (Agent SDK) oder "fake" (deterministisch, für Tests/E2E). */
    backend: 'claude' | 'fake';
    fakeDelayMs: number;
    /**
     * Stiller Config-Warmup beim Projekt-Öffnen. Für die schnelle Claude-API eine
     * Latenz-Optimierung; bei langsamen lokalen Modellen belegt er den Ein-Turn-
     * Daemon so lange, dass der erste echte Prompt abgewiesen wird — dann abschalten
     * (MACVIBES_DISABLE_PREWARM=1).
     */
    prewarm: boolean;
  };
  anthropic: {
    upstreamUrl: string;
    /** Abo-Token (claude setup-token) — bevorzugt. */
    oauthToken: string | null;
    /** Alternativ: klassischer API-Key. */
    apiKey: string | null;
  };
  /**
   * Lokaler Modell-Router (LiteLLM-Shim vor Ollama) — Ziel aller NICHT-Claude-
   * Modelle. Der Credential-Proxy routet pro Request nach dem `model` im Body.
   */
  localModels: {
    upstreamUrl: string;
    apiKey: string;
  };
  /**
   * Zusätzliche Modell-Routen (OpenRouter-Stil) aus MACVIBES_MODEL_ROUTES —
   * JSON-Array [{prefix, upstreamUrl, apiKey?}], matcht VOR den Default-Routen.
   * So lassen sich weitere Anbieter samt eigenem Key einhängen.
   */
  modelRoutes: Array<{ prefix: string; upstreamUrl: string; apiKey?: string }>;
  mirror: {
    /** GitHub-Remote für macvibes-apps (mit Token). Null = Mirror aus. */
    remoteUrl: string | null;
    intervalMs: number;
  };
}

const DEFAULT_TEMPLATES_DIR = resolve(
  fileURLToPath(new URL('../../../templates', import.meta.url)),
);
const DEFAULT_WEB_DIST_DIR = resolve(fileURLToPath(new URL('../../web/dist', import.meta.url)));

export function resolveDbPath(): string {
  if (Bun.env.DB_PATH) return Bun.env.DB_PATH;
  return Bun.env.MACVIBES_TEST_MODE === '1' ? './data/app-test.db' : './data/app.db';
}

/** MACVIBES_MODEL_ROUTES parsen — nie werfen, ungültige Werte klar melden. */
function parseModelRoutes(
  raw: string | undefined,
): Array<{ prefix: string; upstreamUrl: string; apiKey?: string }> {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('kein Array');
    return parsed.filter(
      (r): r is { prefix: string; upstreamUrl: string; apiKey?: string } =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Record<string, unknown>)['prefix'] === 'string' &&
        typeof (r as Record<string, unknown>)['upstreamUrl'] === 'string',
    );
  } catch (error) {
    console.error('MACVIBES_MODEL_ROUTES ungültig (JSON-Array erwartet) — ignoriert:', error);
    return [];
  }
}

export function loadConfig(): ServerConfig {
  const macvibesHome = Bun.env.MACVIBES_HOME ?? join(homedir(), 'macvibes');
  return {
    port: Number(Bun.env.PORT ?? 4000),
    hostname: Bun.env.HOST ?? '0.0.0.0',
    macvibesHome,
    bareRepoPath: join(macvibesHome, 'macvibes-apps.git'),
    templatesDir: Bun.env.MACVIBES_TEMPLATES_DIR ?? DEFAULT_TEMPLATES_DIR,
    adminUsername: Bun.env.MACVIBES_ADMIN_USERNAME || undefined,
    dbPath: resolveDbPath(),
    sessionTtlMs: 3 * 24 * 60 * 60 * 1000,
    webDistDir: Bun.env.MACVIBES_WEB_DIST ?? DEFAULT_WEB_DIST_DIR,
    sandbox: {
      graceMs: Number(Bun.env.MACVIBES_GRACE_MS ?? 15 * 60 * 1000),
      idleMs: Number(Bun.env.MACVIBES_IDLE_MS ?? 30 * 60 * 1000),
      maxSandboxes: Number(Bun.env.MACVIBES_MAX_SANDBOXES ?? 8),
      backend:
        Bun.env.MACVIBES_SANDBOX === 'process' || Bun.env.MACVIBES_SANDBOX === 'microsandbox'
          ? Bun.env.MACVIBES_SANDBOX
          : 'auto',
      image: Bun.env.MACVIBES_SANDBOX_IMAGE ?? 'oven/bun',
      cpus: Number(Bun.env.MACVIBES_SANDBOX_CPUS ?? 4),
      memoryMib: Number(Bun.env.MACVIBES_SANDBOX_MEMORY_MIB ?? 4096),
      previewGatewayPort: Number(Bun.env.MACVIBES_PREVIEW_GATEWAY_PORT ?? 4173),
    },
    agent: {
      backend: Bun.env.MACVIBES_AGENT === 'fake' ? 'fake' : 'claude',
      fakeDelayMs: Number(Bun.env.MACVIBES_FAKE_DELAY_MS ?? 25),
      prewarm:
        Bun.env.MACVIBES_DISABLE_PREWARM !== '1' && Bun.env.MACVIBES_DISABLE_PREWARM !== 'true',
    },
    anthropic: {
      upstreamUrl: Bun.env.ANTHROPIC_UPSTREAM_URL ?? 'https://api.anthropic.com',
      oauthToken: Bun.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      apiKey: Bun.env.ANTHROPIC_API_KEY ?? null,
    },
    localModels: {
      upstreamUrl: Bun.env.MACVIBES_LOCAL_UPSTREAM_URL ?? 'http://localhost:8787',
      apiKey: Bun.env.MACVIBES_LOCAL_API_KEY ?? 'local',
    },
    modelRoutes: parseModelRoutes(Bun.env.MACVIBES_MODEL_ROUTES),
    mirror: {
      remoteUrl: Bun.env.MACVIBES_GITHUB_REMOTE ?? null,
      intervalMs: Number(Bun.env.MACVIBES_MIRROR_INTERVAL_MS ?? 10 * 60 * 1000),
    },
  };
}
