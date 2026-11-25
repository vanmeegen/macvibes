import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_SANDBOXES } from '@macvibes/shared';
import { macvibesHomeDir, parseEnvFile } from '@macvibes/shared/node';

/** Modell-Route aus `MACVIBES_MODEL_ROUTES`: Präfix → Upstream samt optionalem Key. */
interface ModelRouteConfig {
  prefix: string;
  upstreamUrl: string;
  apiKey?: string;
}

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
  /**
   * MACVIBES_ADMIN_BOOTSTRAP_TOKEN: Out-of-Band-Secret für die
   * Erst-Registrierung des Bootstrap-Admins. Gesetzt ⇒ der Bootstrap-Name ist
   * RESERVIERT und register() verlangt genau dieses Token — sonst könnte auf
   * einer frischen Instanz (Erstinstallation, DB-Reset, neuer DB_PATH) jeder
   * im LAN, der sich zuerst mit dem Namen registriert, Admin werden UND den
   * Namen für den echten Betreiber blockieren. null ⇒ Alt-Verhalten
   * (Rückwärtskompatibilität; ensureAdmin warnt beim Start, solange kein
   * Admin existiert).
   */
  adminBootstrapToken: string | null;
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
     * System-Anweisung (agent/appendPrompt); null = eingebauter Default. Gilt
     * für beide Agent-Pfade: der Host-Runner bekommt den Wert direkt, der
     * VM-Daemon über seine VM-Env (agent/vmAgentEnv).
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
   * Lokaler Modell-Server (Default: oMLX, spricht Anthropics /v1/messages
   * nativ) — Ziel aller NICHT-Claude-Modelle ohne eigene Route. Der
   * Credential-Proxy routet pro Request nach dem `model` im Body.
   */
  localModels: {
    upstreamUrl: string;
    apiKey: string;
    /**
     * Health-Pfad relativ zur Upstream-URL (MACVIBES_LOCAL_SERVER_PROBE_PATH;
     * alter Name MACVIBES_LOCAL_ROUTER_PROBE_PATH gilt als Alias).
     * oMLX: `/health`; eine LiteLLM-Instanz als Upstream: `/health/liveliness`.
     */
    probePath: string;
    /**
     * Startkommando für den Server (Autostart durch macvibes, nur wenn auf der
     * URL noch nichts Gesundes antwortet). Env MACVIBES_LOCAL_SERVER_CMD
     * (alter Name MACVIBES_LOCAL_ROUTER_CMD gilt als Alias);
     * Default: `omlx serve`, falls `omlx` im PATH ist. null = kein Autostart.
     */
    serverCommand: string | null;
  };
  /**
   * Optionale LiteLLM-Bridge (apps/server/local-router): übersetzt Anthropic-
   * Format auf OpenAI-kompatible Cloud-Anbieter (OpenRouter, OpenAI). Für das
   * lokale Modell nicht nötig. Startet nur, wenn `<macvibesHome>/litellm.yaml`
   * existiert (legt `bun run setup` an) oder MACVIBES_LITELLM_AUTOSTART=1.
   */
  litellm: {
    url: string;
    command: string | null;
    autostart: boolean;
  };
  /**
   * Zusätzliche Modell-Routen (OpenRouter-Stil) aus MACVIBES_MODEL_ROUTES —
   * JSON-Array [{prefix, upstreamUrl, apiKey?}], matcht VOR den Default-Routen.
   * So lassen sich weitere Anbieter samt eigenem Key einhängen.
   */
  modelRoutes: ModelRouteConfig[];
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

/** Datenverzeichnis: `MACVIBES_HOME`, sonst `~/macvibes`. */
function defaultMacvibesHome(): string {
  return macvibesHomeDir(Bun.env);
}

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
  const name = 'app.db';
  const legacy = join(serverRoot, 'data', name);
  if (existsSync(legacy)) return legacy;
  const home = macvibesHome ?? defaultMacvibesHome();
  return join(home, 'data', name);
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
function parseModelRoutes(raw: string | undefined): ModelRouteConfig[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('kein Array');
    return parsed.filter(
      (r): r is ModelRouteConfig =>
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
 * Startskript der mitgelieferten LiteLLM-Bridge (apps/server/local-router/run.ts)
 * — Teil des Repos, legt seine venv beim ersten Start selbst an (~/macvibes).
 * Single-Quotes fürs Kommando: die Bun-Shell (core/exec) nimmt sie wörtlich,
 * auch bei Pfaden mit Leerzeichen oder Backslashes.
 */
function detectLitellmCommand(): string | null {
  const script = resolve(fileURLToPath(new URL('../local-router/run.ts', import.meta.url)));
  return existsSync(script) ? `'${process.execPath}' '${script}'` : null;
}

/**
 * Startkommando des lokalen Modell-Servers: `omlx serve` im Vordergrund (wird
 * vom ProcessSupervisor überwacht). Läuft oMLX schon als brew-Service auf der
 * URL, greift das Kommando nie (der Supervisor übernimmt „extern"). Fehlt
 * `omlx` im PATH, gibt es keinen Autostart — Claude-Modelle laufen trotzdem.
 */
function detectLocalServerCommand(): string | null {
  const omlx = Bun.which('omlx');
  return omlx === null ? null : `'${omlx}' serve`;
}

/**
 * Zahl aus der Env; undefined (auch bei leerem Wert) = Default des Konsumenten.
 * Ein nicht-numerischer Wert wird gemeldet und verworfen statt als NaN
 * durchgereicht: ein NaN-Port bindet nichts, eine NaN-Frist läuft nie ab und
 * `x >= NaN` ist immer false — ein Tippfehler darf keine Grenze abschalten.
 */
function envNumber(name: string): number | undefined {
  const raw = Bun.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`${name}="${raw}" ist keine Zahl — es gilt der Default.`);
    return undefined;
  }
  return value;
}

/**
 * Env-Wert unter seinem heutigen Namen, sonst unter dem früheren. Der neue
 * Name gewinnt; der alte bleibt gültig, damit bestehende .env-Dateien nach
 * einer Umbenennung weiterlaufen.
 */
function envWithAlias(name: string, legacyName: string): string | undefined {
  return Bun.env[name] ?? Bun.env[legacyName];
}

/** Schalter: '1' ODER 'true' — für ALLE Flags dieselbe Regel. */
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
  return join(macvibesHome ?? defaultMacvibesHome(), '.env');
}

export function loadConfig(): ServerConfig {
  const macvibesHome = defaultMacvibesHome();
  return {
    port: envNumber('PORT') ?? 4000,
    hostname: Bun.env.HOST ?? '0.0.0.0',
    macvibesHome,
    bareRepoPath: join(macvibesHome, 'macvibes-apps.git'),
    templatesDir: Bun.env.MACVIBES_TEMPLATES_DIR ?? DEFAULT_TEMPLATES_DIR,
    adminUsername: Bun.env.MACVIBES_ADMIN_USERNAME || undefined,
    forceAdmin: envFlag('MACVIBES_FORCE_ADMIN'),
    adminBootstrapToken: Bun.env.MACVIBES_ADMIN_BOOTSTRAP_TOKEN || null,
    dbPath: resolveDbPath(macvibesHome),
    sessionTtlMs: 3 * 24 * 60 * 60 * 1000,
    webDistDir: Bun.env.MACVIBES_WEB_DIST ?? DEFAULT_WEB_DIST_DIR,
    sandbox: {
      graceMs: envNumber('MACVIBES_GRACE_MS') ?? 15 * 60 * 1000,
      idleMs: envNumber('MACVIBES_IDLE_MS') ?? 30 * 60 * 1000,
      // NaN-Härtung (envNumber): ein vertippter Wert deaktivierte sonst die
      // LRU-Eviction (`active().length >= NaN` ist immer false → unbegrenzt
      // viele VMs).
      maxSandboxes: envNumber('MACVIBES_MAX_SANDBOXES') ?? DEFAULT_MAX_SANDBOXES,
      backend:
        Bun.env.MACVIBES_SANDBOX === 'process' || Bun.env.MACVIBES_SANDBOX === 'microsandbox'
          ? Bun.env.MACVIBES_SANDBOX
          : 'auto',
      // Bun-Version bewusst gepinnt (kein "latest"-Tag): das nächste große Bun
      // ist ein Rust-Rewrite — Upgrade nur nach intensivem Test aller Sandbox-Pfade.
      image: Bun.env.MACVIBES_SANDBOX_IMAGE ?? 'oven/bun:1.4.5',
      cpus: envNumber('MACVIBES_SANDBOX_CPUS') ?? 4,
      memoryMib: envNumber('MACVIBES_SANDBOX_MEMORY_MIB') ?? 4096,
      previewGatewayPort: envNumber('MACVIBES_PREVIEW_GATEWAY_PORT') ?? 4173,
      // HTTPS-Port des Preview-Gateways (TLS-Terminierung z. B. via Caddy) —
      // null = kein HTTPS; die iframe-URL nutzt dann http (LAN wie bisher).
      previewGatewayHttpsPort: envNumber('MACVIBES_PREVIEW_GATEWAY_HTTPS_PORT') ?? null,
    },
    agent: {
      backend: Bun.env.MACVIBES_AGENT === 'fake' ? 'fake' : 'claude',
      fakeDelayMs: envNumber('MACVIBES_FAKE_DELAY_MS') ?? 25,
      prewarm: !envFlag('MACVIBES_DISABLE_PREWARM'),
      allowHostAgent: envFlag('MACVIBES_ALLOW_HOST_AGENT'),
      // Leer zählt als „nicht gesetzt": eine auskommentiert-leere Zeile soll die
      // eingebaute Anweisung nicht abschalten.
      appendSystemPrompt: Bun.env.MACVIBES_AGENT_APPEND_PROMPT || null,
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
    debugErrors: envFlag('MACVIBES_DEBUG_ERRORS'),
    rateLimitDisabled: envFlag('MACVIBES_RATE_LIMIT_DISABLED'),
    localModels: {
      upstreamUrl: Bun.env.MACVIBES_LOCAL_UPSTREAM_URL ?? 'http://localhost:8000',
      apiKey: Bun.env.MACVIBES_LOCAL_API_KEY ?? 'local',
      // Alte Namen (MACVIBES_LOCAL_ROUTER_*) gelten als Alias weiter.
      probePath:
        envWithAlias('MACVIBES_LOCAL_SERVER_PROBE_PATH', 'MACVIBES_LOCAL_ROUTER_PROBE_PATH') ??
        '/health',
      serverCommand:
        envWithAlias('MACVIBES_LOCAL_SERVER_CMD', 'MACVIBES_LOCAL_ROUTER_CMD') ??
        detectLocalServerCommand(),
    },
    litellm: {
      url: Bun.env.MACVIBES_LITELLM_URL ?? 'http://localhost:8787',
      command: Bun.env.MACVIBES_LITELLM_CMD ?? detectLitellmCommand(),
      autostart:
        envFlag('MACVIBES_LITELLM_AUTOSTART') || existsSync(join(macvibesHome, 'litellm.yaml')),
    },
    modelRoutes: parseModelRoutes(Bun.env.MACVIBES_MODEL_ROUTES),
    mirror: {
      remoteUrl: Bun.env.MACVIBES_GITHUB_REMOTE ?? null,
      intervalMs: envNumber('MACVIBES_MIRROR_INTERVAL_MS') ?? 10 * 60 * 1000,
    },
  };
}
