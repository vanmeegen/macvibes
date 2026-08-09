import { existsSync, readFileSync } from 'node:fs';
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
  /**
   * MACVIBES_FORCE_ADMIN: befördert den Bootstrap-Admin auch dann, wenn
   * bereits ein Admin existiert (F21 — ohne Flag nur echter Bootstrap).
   */
  forceAdmin: boolean;
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
    /** HTTPS-Port des Gateways (TLS-Terminierung via Caddy) — null ohne TLS. */
    previewGatewayHttpsPort: number | null;
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
    /**
     * MACVIBES_ALLOW_HOST_AGENT: ausdrücklicher Verzicht auf das VM-Isolat —
     * der echte Agent darf als Host-Prozess laufen (F9, nur Dev).
     */
    allowHostAgent: boolean;
    /**
     * MACVIBES_AGENT_APPEND_PROMPT: überschreibt die eingebaute Zusatz-
     * System-Anweisung des Host-Runners; null = eingebauter Default
     * (agent/claudeRunner). Der VM-Daemon liest sie weiterhin aus seiner
     * VM-Env — dort IST die Env der Host→VM-Transport.
     */
    appendSystemPrompt: string | null;
    /**
     * Turn-Fristen des ChatService (MACVIBES_AGENT_*_TIMEOUT_MS); undefined =
     * eingebauter Default des ChatService. Die slow*-Werte greifen bei
     * langsamen (lokalen) Modellen.
     */
    timeouts: {
      idleMs: number | undefined;
      firstEventMs: number | undefined;
      coldStartMs: number | undefined;
      warmupMs: number | undefined;
      slowIdleMs: number | undefined;
      slowFirstEventMs: number | undefined;
      slowColdStartMs: number | undefined;
    };
  };
  anthropic: {
    upstreamUrl: string;
    /** Abo-Token (claude setup-token) — bevorzugt. */
    oauthToken: string | null;
    /** Alternativ: klassischer API-Key. */
    apiKey: string | null;
    /**
     * MACVIBES_PROXY_KEEPALIVE_MS: Takt der SSE-Keepalives des Credential-
     * Proxys; undefined = Default des Proxys (http/anthropicProxy).
     */
    keepAliveMs: number | undefined;
  };
  /** Egress-Proxy: einziger Weg der VMs ins Internet (F3). */
  egress: {
    /** MACVIBES_EGRESS_PORT: Port des CONNECT-Proxys auf dem Host. */
    port: number;
    /**
     * MACVIBES_EGRESS_PORTS: öffentliche Zielports, die eine VM ansteuern
     * darf; ungültige Einträge werden gefiltert, leer ⇒ [80, 443].
     */
    allowedPorts: number[];
  };
  /**
   * MACVIBES_WEB_PORT: Dev-Port des Vite-Servers — im Dev eine erlaubte
   * Origin (F5). Bewusst OHNE Default 5173: in Produktion liefe dort die
   * erste Sandbox-Preview, die Allowlist vertraute sonst dem vom Agenten
   * kontrollierten Ursprung (s. Kommentar in index.ts).
   */
  devWebPort: number | null;
  /** MACVIBES_ALLOWED_ORIGINS: zusätzlich erlaubte Origins (F5/F6), kommagetrennt. */
  allowedOrigins: string[];
  /** MACVIBES_DEBUG_ERRORS=1: hebt die Fehlermaskierung (F24) zur Fehlersuche auf. */
  debugErrors: boolean;
  /** MACVIBES_RATE_LIMIT_DISABLED=1: schaltet das Rate-Limit (F14) ab — nur E2E. */
  rateLimitDisabled: boolean;
  /**
   * Lokaler Modell-Router (LiteLLM-Shim vor Ollama) — Ziel aller NICHT-Claude-
   * Modelle. Der Credential-Proxy routet pro Request nach dem `model` im Body.
   */
  localModels: {
    upstreamUrl: string;
    apiKey: string;
    /**
     * Startkommando für den Shim (Autostart durch macvibes). Env
     * MACVIBES_LOCAL_ROUTER_CMD; Default: das mitgelieferte
     * apps/server/local-router/run.ts. null = kein Autostart.
     */
    routerCommand: string | null;
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

/** <serverRoot> = apps/server (das Verzeichnis über src/), modul-relativ. */
const SERVER_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Pfad der SQLite-DB.
 *
 * Neue Installationen legen sie unter `<macvibesHome>/data` an, NICHT mehr
 * unter dem Repo-Root (F7): der Vite-Dev-Server bindet 0.0.0.0 und lieferte
 * über `/@fs/` alles unterhalb des Repos aus — inklusive der DB mit
 * Session-Tokens im Klartext. Eine vorhandene Alt-DB wird weiter benutzt,
 * damit niemand beim Update stillschweigend seine Daten verliert.
 *
 * Der Legacy-Ort wird DETERMINISTISCH gegen das Server-Modul aufgelöst
 * (`<serverRoot>/data/<name>`), NICHT relativ zum cwd. Früher war er
 * `./data/<name>`: bei `bun run start` (cd apps/server) traf das im Repo die
 * echte DB, bei einer Homebrew-Installation (cwd `<libexec>/apps/server`) aber
 * NICHTS — dort wurde deshalb eine frische DB im Home angelegt und die
 * Bestandsdaten blieben unsichtbar. `serverRoot` ist nur für Tests injizierbar.
 */
export function resolveDbPath(macvibesHome?: string, serverRoot: string = SERVER_ROOT): string {
  if (Bun.env.DB_PATH) return Bun.env.DB_PATH;
  const name = Bun.env.MACVIBES_TEST_MODE === '1' ? 'app-test.db' : 'app.db';
  const legacy = join(serverRoot, 'data', name);
  if (existsSync(legacy)) return legacy;
  const home = macvibesHome ?? Bun.env.MACVIBES_HOME ?? join(homedir(), 'macvibes');
  return join(home, 'data', name);
}

/**
 * Minimaler Parser für die Home-Fallback-`.env` (`<macvibesHome>/.env`).
 *
 * Bewusst OHNE `$`-Expansion — anders als Buns cwd-Autolader, der `$VAR` auch in
 * Single-Quotes expandiert (Quirk, dokumentiert in scripts/lib/setup.ts). Das
 * Setup schreibt hier ohnehin nur single-quotierte Werte ohne `$`/`\`/`'`
 * (envQuote lehnt die ab), deshalb ist literales Lesen korrekt und frei von
 * Überraschungs-Expansion. Umschließende einfache/doppelte Quotes werden
 * entfernt; Kommentar- und Leerzeilen ignoriert.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"')))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1] as string] = value;
  }
  return out;
}

/**
 * Reine Vorrang-Auflösung der drei Konfig-Quellen (OHNE Prozess-Env-Mutation,
 * damit testbar). Später = höhere Priorität:
 *   (3) homeEnv  <  (2) repoEnv  <  (1) explicitEnv
 * Zur Laufzeit hat Bun explicitEnv und repoEnv (die cwd-`.env`) bereits in
 * `Bun.env` verschmolzen — die explizite Env gewinnt dort schon (empirisch
 * gegen Bun 1.3.14 verifiziert). `loadHomeEnvFile` füllt danach nur noch die in
 * `Bun.env` FEHLENDEN Home-Keys, wodurch genau diese Ordnung entsteht.
 */
export function resolveEnvPrecedence(
  explicitEnv: Record<string, string | undefined>,
  repoEnv: Record<string, string>,
  homeEnv: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...homeEnv, ...repoEnv };
  for (const [key, value] of Object.entries(explicitEnv)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Fall 3 der Konfig-Vorrangregel: `<macvibesHome>/.env` als upgrade-feste
 * Fallback-Datei laden. Bun lädt automatisch NUR die cwd-`.env` (Fall 2), dieser
 * Ort muss EXPLIZIT geladen werden. Bereits gesetzte Variablen (explizit ODER
 * aus der cwd-`.env`) werden NIE überschrieben — sonst kippte Regel 1/2. Damit
 * läuft der Dev-Checkout dieser Maschine unverändert weiter: seine
 * apps/server/.env (cwd-`.env`) gewinnt gegen jeden Home-Eintrag. Idempotent.
 */
export function loadHomeEnvFile(homeEnvPath: string): void {
  if (!existsSync(homeEnvPath)) return;
  let content: string;
  try {
    content = readFileSync(homeEnvPath, 'utf8');
  } catch (error) {
    console.warn(`Home-.env ${homeEnvPath} nicht lesbar — übersprungen:`, error);
    return;
  }
  for (const [key, value] of Object.entries(parseEnvFile(content))) {
    if (Bun.env[key] === undefined) Bun.env[key] = value;
  }
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

/**
 * Startskript des mitgelieferten Routers (apps/server/local-router/run.ts) —
 * Teil des Repos, legt seine venv beim ersten Start selbst an (~/macvibes).
 * Single-Quotes fürs Kommando: die Bun-Shell (core/exec) nimmt sie wörtlich,
 * auch bei Pfaden mit Leerzeichen oder Backslashes.
 */
function detectLocalRouterCommand(): string | null {
  const script = resolve(fileURLToPath(new URL('../local-router/run.ts', import.meta.url)));
  return existsSync(script) ? `'${process.execPath}' '${script}'` : null;
}

/** Zahl aus der Env; undefined (auch bei leerem Wert) = Default des Konsumenten. */
function envNumber(name: string): number | undefined {
  const raw = Bun.env[name];
  return raw ? Number(raw) : undefined;
}

/** Schalter, der wie bisher '1' ODER 'true' akzeptiert. */
function envFlag(name: string): boolean {
  const raw = Bun.env[name];
  return raw === '1' || raw === 'true';
}

/** Default-Zielports des Egress-Proxys (F3) — nur HTTP(S) ins öffentliche Netz. */
export const DEFAULT_EGRESS_ALLOWED_PORTS: readonly number[] = [80, 443];

/**
 * MACVIBES_EGRESS_PORTS parsen (Semantik unverändert aus http/egressPolicy
 * hierher gezogen, M6): ungültige Einträge fliegen raus, eine leere Liste
 * fällt auf den Default zurück — Tippfehler dürfen den Proxy nicht aufreißen.
 */
function parseEgressPorts(raw: string | undefined): number[] {
  if (!raw) return [...DEFAULT_EGRESS_ALLOWED_PORTS];
  const ports = raw
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
  return ports.length > 0 ? ports : [...DEFAULT_EGRESS_ALLOWED_PORTS];
}

/** MACVIBES_ALLOWED_ORIGINS: kommagetrennt, Leerraum tolerant (F5/F6). */
function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Pfad der nutzereigenen, upgrade-festen Konfiguration (Fall 3 der
 * Vorrangregel). Die Composition Root lädt sie beim Start — bewusst NICHT
 * `loadConfig()`: das Lesen mutiert `Bun.env` global, und ein Unit-Test, der
 * nur die Config auflösen will, zöge sonst auf einer INSTALLIERTEN Maschine
 * die echten Secrets des Nutzers in seine Prozessumgebung (und könnte damit
 * Default-Tests kippen). Seiteneffekte gehören an den Rand, nicht in eine
 * Auflösungsfunktion.
 */
export function homeEnvPathFor(macvibesHome?: string): string {
  return join(macvibesHome ?? Bun.env.MACVIBES_HOME ?? homedir() + '/macvibes', '.env');
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
    forceAdmin: envFlag('MACVIBES_FORCE_ADMIN'),
    dbPath: resolveDbPath(macvibesHome),
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
      // Bun-Version bewusst gepinnt (kein "latest"-Tag): das nächste große Bun
      // ist ein Rust-Rewrite — Upgrade nur nach intensivem Test aller Sandbox-Pfade.
      image: Bun.env.MACVIBES_SANDBOX_IMAGE ?? 'oven/bun:1.3.14',
      cpus: Number(Bun.env.MACVIBES_SANDBOX_CPUS ?? 4),
      memoryMib: Number(Bun.env.MACVIBES_SANDBOX_MEMORY_MIB ?? 4096),
      previewGatewayPort: Number(Bun.env.MACVIBES_PREVIEW_GATEWAY_PORT ?? 4173),
      // HTTPS-Port des Preview-Gateways (TLS-Terminierung z. B. via Caddy) —
      // null = kein HTTPS; die iframe-URL nutzt dann http (LAN wie bisher).
      previewGatewayHttpsPort: Bun.env.MACVIBES_PREVIEW_GATEWAY_HTTPS_PORT
        ? Number(Bun.env.MACVIBES_PREVIEW_GATEWAY_HTTPS_PORT)
        : null,
    },
    agent: {
      backend: Bun.env.MACVIBES_AGENT === 'fake' ? 'fake' : 'claude',
      fakeDelayMs: Number(Bun.env.MACVIBES_FAKE_DELAY_MS ?? 25),
      prewarm:
        Bun.env.MACVIBES_DISABLE_PREWARM !== '1' && Bun.env.MACVIBES_DISABLE_PREWARM !== 'true',
      allowHostAgent: envFlag('MACVIBES_ALLOW_HOST_AGENT'),
      appendSystemPrompt: Bun.env.MACVIBES_AGENT_APPEND_PROMPT ?? null,
      timeouts: {
        idleMs: envNumber('MACVIBES_AGENT_IDLE_TIMEOUT_MS'),
        firstEventMs: envNumber('MACVIBES_AGENT_FIRST_EVENT_TIMEOUT_MS'),
        coldStartMs: envNumber('MACVIBES_AGENT_COLD_START_TIMEOUT_MS'),
        warmupMs: envNumber('MACVIBES_AGENT_WARMUP_TIMEOUT_MS'),
        slowIdleMs: envNumber('MACVIBES_AGENT_SLOW_IDLE_TIMEOUT_MS'),
        slowFirstEventMs: envNumber('MACVIBES_AGENT_SLOW_FIRST_EVENT_TIMEOUT_MS'),
        slowColdStartMs: envNumber('MACVIBES_AGENT_SLOW_COLD_START_TIMEOUT_MS'),
      },
    },
    anthropic: {
      upstreamUrl: Bun.env.ANTHROPIC_UPSTREAM_URL ?? 'https://api.anthropic.com',
      oauthToken: Bun.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      apiKey: Bun.env.ANTHROPIC_API_KEY ?? null,
      keepAliveMs: envNumber('MACVIBES_PROXY_KEEPALIVE_MS'),
    },
    egress: {
      port: envNumber('MACVIBES_EGRESS_PORT') ?? 4010,
      allowedPorts: parseEgressPorts(Bun.env.MACVIBES_EGRESS_PORTS),
    },
    devWebPort: envNumber('MACVIBES_WEB_PORT') ?? null,
    allowedOrigins: parseAllowedOrigins(Bun.env.MACVIBES_ALLOWED_ORIGINS),
    debugErrors: Bun.env.MACVIBES_DEBUG_ERRORS === '1',
    rateLimitDisabled: Bun.env.MACVIBES_RATE_LIMIT_DISABLED === '1',
    localModels: {
      upstreamUrl: Bun.env.MACVIBES_LOCAL_UPSTREAM_URL ?? 'http://localhost:8787',
      apiKey: Bun.env.MACVIBES_LOCAL_API_KEY ?? 'local',
      routerCommand: Bun.env.MACVIBES_LOCAL_ROUTER_CMD ?? detectLocalRouterCommand(),
    },
    modelRoutes: parseModelRoutes(Bun.env.MACVIBES_MODEL_ROUTES),
    mirror: {
      remoteUrl: Bun.env.MACVIBES_GITHUB_REMOTE ?? null,
      intervalMs: Number(Bun.env.MACVIBES_MIRROR_INTERVAL_MS ?? 10 * 60 * 1000),
    },
  };
}
