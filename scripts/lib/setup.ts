/**
 * Reine, testbare Helfer des geführten First-Run-Setups (`bun run setup`).
 *
 * Bewusst OHNE Syscalls und OHNE Import aus `apps/server/src/**`: die Skripte
 * sind Composition-Root-artig und stehen außerhalb des Server-Schicht-Gates
 * (M6). Die interaktive Schale (scripts/setup.ts) sammelt die echten Zustände
 * und ruft diese Funktionen; hier lebt nur die Logik, damit sie ohne hängende
 * Prompts getestet werden kann.
 *
 * Env-Namen sind die WAHRHEIT aus apps/server/src/config.ts / .env.example:
 *   CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, MACVIBES_ADMIN_USERNAME,
 *   MACVIBES_ADMIN_BOOTSTRAP_TOKEN, MACVIBES_SANDBOX, MACVIBES_MODEL_ROUTES.
 */
import { join } from 'node:path';

/** Eine zusätzliche Modell-Route (OpenRouter-Stil), wie config.ts sie parst. */
export interface ModelRoute {
  prefix: string;
  upstreamUrl: string;
  apiKey?: string;
}

/**
 * Anbieter-Wahl. Kombinierbar — Claude und Zusatz-Anbieter schließen sich
 * NICHT aus (der Credential-Proxy routet pro Request nach dem `model` im Body).
 *   - claude-oauth     : Abo-Token (claude setup-token), bevorzugt
 *   - claude-apikey    : klassischer Anthropic-API-Key
 *   - ollama           : lokale Modelle über den mitgelieferten LiteLLM-Router
 *   - custom-anthropic : eigener Anbieter, dessen Endpunkt die Format-PROBE
 *                        (lib/providerProbe) als Anthropic-/v1/messages-
 *                        kompatibel erkannt hat → direkte Modell-Route
 *   - custom-openai    : eigener Anbieter mit OpenAI-Format (/chat/completions)
 *                        → läuft über den LiteLLM-Router (Format-Übersetzung)
 *
 * WARUM custom-openai NICHT als Modell-Route: der Credential-Proxy hängt den
 * Request-Pfad an die `upstreamUrl` einer Route an und schickt Anthropic-Format
 * (anthropicProxy.ts) — eine rohe OpenAI-URL in MACVIBES_MODEL_ROUTES kann
 * deshalb NICHT funktionieren (Format-Mismatch). Der Weg ist der mitgelieferte
 * LiteLLM-Router; er liest den Anbieter-Key aus der Env (`os.environ/<envVar>`,
 * Name abgeleitet aus dem Anzeigenamen, s. lib/providerWiring.envVarName).
 * Der Nutzer muss den Unterschied NICHT kennen — die Probe entscheidet.
 */
export type ProviderChoice =
  | { kind: 'claude-oauth'; token: string }
  | { kind: 'claude-apikey'; apiKey: string }
  | { kind: 'ollama' }
  | {
      kind: 'custom-anthropic';
      /** Anzeigename des Anbieters (nur für Kommentare/Meldungen). */
      name: string;
      /** Ausgewählte Modelle des Anbieters (mindestens eines). */
      modelle: AnbieterModell[];
      /** Basis-URL des Endpunkts (der Proxy hängt /v1/messages an). */
      url: string;
      token?: string;
    }
  | {
      kind: 'custom-openai';
      name: string;
      modelle: AnbieterModell[];
      /** api_base für LiteLLM — exakt die Basis, auf die die Probe ansprang. */
      apiBase: string;
      /** Abgeleiteter Env-Name (providerWiring.envVarName), z. B. ACME_API_KEY. */
      envVar: string;
      token: string;
    };

/**
 * Ein ausgewähltes Modell eines eigenen Anbieters. Ein Anbieter bietet
 * Dutzende Modelle und das Modell wird pro Chat im Dropdown gewählt — deshalb
 * bindet das Setup pro Anbieter eine LISTE an, nicht eine einzelne Modell-ID.
 */
export interface AnbieterModell {
  /** Modell-ID beim Anbieter — zugleich die `id` in models.json. */
  id: string;
  /** Anzeigename fürs Chat-Dropdown (models.json), inkl. Anbietername. */
  label: string;
}

/** Sandbox-Backend, exakt die Werte, die config.ts akzeptiert. */
export type SandboxMode = 'auto' | 'process' | 'microsandbox';

/** Gesammelte Antworten des Setups → speisen buildEnvContent(). */
export interface SetupAnswers {
  /** MACVIBES_ADMIN_USERNAME — Pflicht (Aussperr-Absicherung, H3). */
  adminUsername: string;
  /**
   * MACVIBES_ADMIN_BOOTSTRAP_TOKEN — vom Setup automatisch erzeugt (CSPRNG,
   * hex; scripts/setup.ts), damit neue Installationen standardmäßig sicher
   * sind: ohne den Token könnte auf einer frischen Instanz jeder im LAN, der
   * den Admin-Namen zuerst registriert, Admin werden. Pflichtfeld, damit kein
   * Aufrufer den Schutz versehentlich weglassen kann.
   */
  adminBootstrapToken: string;
  sandboxMode: SandboxMode;
  providers: ProviderChoice[];
}

/**
 * Eine Anbieter-Wahl auf ihre Env-Vars abbilden.
 *
 * `ollama` liefert bewusst eine LEERE Map: der mitgelieferte Router wird von
 * config.ts über den Default von `MACVIBES_LOCAL_ROUTER_CMD`
 * (detectLocalRouterCommand → gebündeltes local-router/run.ts) automatisch
 * gestartet. Es braucht also KEINE Env, um lokale Modelle zu aktivieren; nur
 * ein abweichender Endpunkt/Command würde MACVIBES_LOCAL_* setzen.
 */
export function providerEnv(choice: ProviderChoice): Record<string, string> {
  switch (choice.kind) {
    case 'claude-oauth':
      return { CLAUDE_CODE_OAUTH_TOKEN: choice.token };
    case 'claude-apikey':
      return { ANTHROPIC_API_KEY: choice.apiKey };
    case 'ollama':
      return {};
    case 'custom-anthropic': {
      // Direkte Routen: der Proxy matcht das `model` im Body per
      // `startsWith(prefix)` — pro Modell EINE Route mit der exakten id.
      //
      // WARUM n Routen statt EINES gemeinsamen Prefixes: ein automatisch
      // berechneter gemeinsamer Präfix wäre gefährlich kurz (glm-4.7 + gpt-oss
      // → "g") und würde still auch FREMDE Modelle — samt deren Requests — an
      // diesen Upstream mit DESSEN Token schicken. Nur wenn der Nutzer selbst
      // einen Namensraum wählt, wäre ein Prefix sinnvoll; das lässt sich nicht
      // zuverlässig ableiten. Exakte ids sind präzise, die Anzahl ist durch
      // die Auswahl begrenzt und config.ts verkraftet beliebig viele Routen.
      //
      // exactOptionalPropertyTypes: apiKey nur aufnehmen, wenn wirklich gesetzt —
      // sonst serialisierte JSON.stringify `"apiKey":undefined` weg, aber der Typ
      // ModelRoute verböte das undefined-Feld.
      const routes: ModelRoute[] = choice.modelle.map((modell) =>
        choice.token === undefined || choice.token === ''
          ? { prefix: modell.id, upstreamUrl: choice.url }
          : { prefix: modell.id, upstreamUrl: choice.url, apiKey: choice.token },
      );
      return routes.length === 0 ? {} : { MACVIBES_MODEL_ROUTES: JSON.stringify(routes) };
    }
    case 'custom-openai':
      // KEINE Modell-Route (Format-Mismatch, s. ProviderChoice) — nur der Key,
      // den der LiteLLM-Router via `os.environ/<envVar>` liest.
      return { [choice.envVar]: choice.token };
  }
}

/**
 * Mehrere (kombinierbare) Anbieter zu EINER Env-Map verschmelzen. Alle
 * `route`-Anbieter fließen dabei in EIN MACVIBES_MODEL_ROUTES-JSON-Array
 * zusammen (config.ts erwartet genau ein Array), Claude-Keys stehen daneben.
 */
export function mergeProviderEnv(choices: ProviderChoice[]): Record<string, string> {
  const merged: Record<string, string> = {};
  const routes: ModelRoute[] = [];
  for (const choice of choices) {
    for (const [key, value] of Object.entries(providerEnv(choice))) {
      if (key === 'MACVIBES_MODEL_ROUTES') {
        routes.push(...(JSON.parse(value) as ModelRoute[]));
      } else {
        merged[key] = value;
      }
    }
  }
  if (routes.length > 0) merged['MACVIBES_MODEL_ROUTES'] = JSON.stringify(routes);
  return merged;
}

/**
 * Zeichen, die eine single-quoted `.env`-Zeile NICHT sicher transportieren kann.
 * Empirisch gegen den echten Bun-1.3.14-Parser verifiziert (s. Round-Trip-Test):
 *   - `$`  : Bun expandiert `$VAR`/`${VAR}` AUCH innerhalb von Single-Quotes →
 *            der Wert würde still ersetzt/injiziert. `\$`-Escaping ist
 *            UNZUVERLÄSSIG (ein auf `$` endender Wert bekäme einen Extra-`\`).
 *   - `\`  : In Single-Quotes behandelt Bun `\'` als escaptes Quote → ein Wert
 *            der auf `\` endet frisst die schließende `'` UND die komplette
 *            Folgezeile (löscht damit z. B. das nächste Secret). `\\` wird in
 *            Single-Quotes NICHT zu `\` entschärft.
 *   - `'`  : terminiert den String vorzeitig; Bun kann es nicht escapen (POSIX
 *            `'\''` wird wörtlich gelesen, nicht zusammengesetzt).
 *   - Steuerzeichen: würden die Zeile zerreißen / sind in .env-Werten unsinnig.
 */
// eslint-disable-next-line no-control-regex -- Steuerzeichen \x00–\x1f bewusst abgelehnt.
const ENV_UNSICHER = /['\\$\x00-\x1f]/;

/**
 * Enthält der Wert ein Zeichen, das eine single-quoted .env-Zeile nicht sicher
 * transportiert (s. ENV_UNSICHER)? Von der interaktiven Schale (scripts/setup.ts)
 * genutzt, um solche Freitext-Eingaben schon am Prompt abzuweisen — dieselbe
 * Regel, an der envQuote sonst erst beim Schreiben (mit Exception) scheitern
 * würde. Eine gemeinsame Quelle statt zweier auseinanderdriftender Prüfungen.
 */
export function envWertIstUnsicher(value: string): boolean {
  return ENV_UNSICHER.test(value);
}

/**
 * Einen Wert für eine `.env`-Zeile sicher single-quoten.
 *
 * WARUM Single-Quotes: Buns dotenv-Parser behandelt in einem UNQUOTED Wert jedes
 * `#` als Beginn eines Inline-Kommentars und schneidet dort ab — ein Secret
 * `sk-ant#x` würde still zu `sk-ant`. Plain Single-Quotes (ohne jedes Escaping)
 * lassen JEDEN Wert literal wieder herauskommen — nachgewiesen für `#`, `` ` ``,
 * `"`, `:`, `/`, `=`, Leerzeichen, `%`, `+` und komplettes JSON. Für das kompakte
 * MACVIBES_MODEL_ROUTES-JSON (mit inneren `"`) sind Single-Quotes zudem die
 * EINZIGE Wahl: Double-Quotes um das JSON würden die inneren `"` als `\"`
 * durchreichen und JSON.parse brechen.
 *
 * WARUM ABLEHNEN statt escapen: die frühere Annahme „Single-Quotes schalten jede
 * Expansion aus" ist gegen den echten Bun-Parser FALSCH (s. ENV_UNSICHER —
 * `$`-Expansion, Trailing-`\`-Zeilenfraß, `'`-Terminierung). Ein zuverlässiges
 * Escaping dieser Zeichen gibt es in Buns Single-Quote-Syntax NICHT (`\$`/`\\`
 * verhalten sich inkonsistent), also werden sie klar abgelehnt statt still ein
 * zerbrochenes/injiziertes .env zu erzeugen. Das ist unkritisch: der
 * Admin-Username (usernameSchema: nur [a-z0-9_-]) kann keines davon enthalten,
 * Secrets/URLs praktisch nie. Die interaktive Schale weist solche Eingaben schon
 * am Prompt ab (bessere Meldung). Das `label` (der KEY-Name, NIE der Wert) hält
 * das Secret aus der Fehlermeldung heraus.
 */
export function envQuote(value: string, label: string): string {
  if (ENV_UNSICHER.test(value)) {
    throw new Error(
      `${label} enthält ein Zeichen, das sich nicht sicher in eine single-quoted .env-Zeile schreiben lässt (' \\ $ oder ein Steuerzeichen). Bitte einen Wert ohne diese Zeichen verwenden.`,
    );
  }
  return `'${value}'`;
}

/**
 * Modell-Liste für einen .env-Kommentar aufzählen — gedeckelt, damit ein
 * Anbieter mit vielen ausgewählten Modellen keinen Kommentar-Wall erzeugt.
 */
function modellAufzaehlung(modelle: AnbieterModell[], limit = 3): string {
  if (modelle.length === 1) return `Modell "${modelle[0]?.id ?? ''}"`;
  const genannt = modelle
    .slice(0, limit)
    .map((m) => `"${m.id}"`)
    .join(', ');
  const rest = modelle.length - limit;
  return rest > 0 ? `Modelle ${genannt} (+${rest} weitere)` : `Modelle ${genannt}`;
}

/**
 * Den `.env`-Inhalt aus den gesammelten Antworten erzeugen — orientiert an
 * apps/server/.env.example, aber nur mit den TATSÄCHLICH gesetzten Keys (kein
 * Rauschen aus leeren Platzhaltern) und knappen Kommentaren.
 *
 * Alle datentragenden Werte werden single-quoted (siehe envQuote): schützt `#`
 * in Secrets/JSON vor Buns Inline-Kommentar-Regel. MACVIBES_SANDBOX ist ein
 * fester Enum-Wert (SandboxMode) aus eigenem Code — kein Fremdtext, kein `#` —
 * und bleibt bewusst unquoted.
 */
export function buildEnvContent(answers: SetupAnswers): string {
  const env = mergeProviderEnv(answers.providers);
  const lines: string[] = [];

  lines.push('# macvibes-Server .env — erzeugt von `bun run setup`.');
  lines.push('# Kanonische Referenz aller Schlüssel: apps/server/.env.example');
  lines.push('# Secrets bleiben auf dem Host (chmod 600) und landen nie in einer Sandbox-VM.');
  lines.push('');
  lines.push('# Bootstrap-Admin (Pflicht, H3): wird beim Start befördert + freigeschaltet —');
  lines.push('# ohne ihn kann niemand Nutzer freischalten.');
  lines.push(
    `MACVIBES_ADMIN_USERNAME=${envQuote(answers.adminUsername, 'MACVIBES_ADMIN_USERNAME')}`,
  );
  lines.push('');
  lines.push('# Bootstrap-Token (vom Setup erzeugt): die Erst-Registrierung als Admin verlangt');
  lines.push('# GENAU diesen Wert im Feld „Bootstrap-Token" — sonst könnte jeder im Netz den');
  lines.push('# Admin-Namen zuerst beanspruchen. Alle anderen Nutzer lassen das Feld leer.');
  lines.push(
    `MACVIBES_ADMIN_BOOTSTRAP_TOKEN=${envQuote(answers.adminBootstrapToken, 'MACVIBES_ADMIN_BOOTSTRAP_TOKEN')}`,
  );
  lines.push('');
  lines.push('# Sandbox-Backend: auto | microsandbox | process (process = ohne VM-Isolat).');
  lines.push(`MACVIBES_SANDBOX=${answers.sandboxMode}`);

  const oauth = env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (oauth !== undefined) {
    lines.push('');
    lines.push('# Claude-Abo-Token (claude setup-token) — bevorzugt; verlässt den Host nie.');
    lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${envQuote(oauth, 'CLAUDE_CODE_OAUTH_TOKEN')}`);
  }
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (apiKey !== undefined) {
    lines.push('');
    lines.push('# Claude-API-Key (Anthropic Console) — verlässt den Host nie.');
    lines.push(`ANTHROPIC_API_KEY=${envQuote(apiKey, 'ANTHROPIC_API_KEY')}`);
  }
  // Eigene OpenAI-kompatible Anbieter: je ein abgeleiteter Key (envVar) — der
  // LiteLLM-Router liest ihn per os.environ/<envVar>. Die Schleife läuft über
  // die providers (nicht die Env-Map), damit der Kommentar den Anbieter und
  // sein Modell benennen kann.
  for (const provider of answers.providers) {
    if (provider.kind !== 'custom-openai') continue;
    lines.push('');
    lines.push(`# ${provider.name} (OpenAI-kompatibel, von der Setup-Probe erkannt) — läuft über`);
    lines.push(
      `# den LiteLLM-Router (Anthropic→OpenAI-Übersetzung). ${modellAufzaehlung(provider.modelle)}:`,
    );
    lines.push('# eingetragen in ~/macvibes/litellm.yaml + ~/macvibes/models.json.');
    lines.push(`${provider.envVar}=${envQuote(env[provider.envVar] ?? '', provider.envVar)}`);
  }
  const routes = env['MACVIBES_MODEL_ROUTES'];
  if (routes !== undefined) {
    lines.push('');
    lines.push('# Direkt angebundene Anthropic-kompatible Anbieter (von der Setup-Probe');
    lines.push('# erkannt) — matchen VOR den Defaults. Der Endpunkt spricht Anthropics');
    lines.push('# /v1/messages; OpenAI-Format liefe stattdessen über den LiteLLM-Router.');
    lines.push('# Format: [{prefix, upstreamUrl, apiKey?}].');
    lines.push(`MACVIBES_MODEL_ROUTES=${envQuote(routes, 'MACVIBES_MODEL_ROUTES')}`);
  }

  // Ollama und OpenAI-kompatible Anbieter laufen über denselben LiteLLM-Router —
  // er startet automatisch (MACVIBES_LOCAL_ROUTER_CMD-Default), keine weitere Env.
  const nutztRouter = answers.providers.some(
    (p) => p.kind === 'ollama' || p.kind === 'custom-openai',
  );
  if (nutztRouter) {
    lines.push('');
    lines.push('# Lokaler LiteLLM-Router (Ollama / OpenAI-kompatible Anbieter) — startet');
    lines.push('# automatisch (MACVIBES_LOCAL_ROUTER_CMD-Default), keine Env nötig.');
    lines.push('# Modell-Aliase: ~/macvibes/litellm.yaml (sonst die mitgelieferte');
    lines.push('# apps/server/local-router/litellm_config.yaml).');
  }

  const hatClaude = oauth !== undefined || apiKey !== undefined;
  if (!hatClaude) {
    lines.push('');
    lines.push('# Hinweis: Kein Claude konfiguriert — nur lokale/zusätzliche Modelle verfügbar.');
  }

  return lines.join('\n') + '\n';
}

/**
 * Wohin schreibt das Setup die `.env`?
 *
 * - Dev-Checkout (ein `.git` im Repo-Root) → der Repo-Override
 *   `apps/server/.env`. Das ist die cwd-`.env`, die Bun automatisch lädt, und
 *   die laut Vorrangregel gegen die Home-`.env` gewinnt — die laufende
 *   Installation dieser Maschine bleibt damit unverändert.
 * - Installierte Fassung (kein `.git`) → die upgrade-feste `<macvibesHome>/.env`.
 *   Sie überlebt `brew upgrade` (das `libexec` ersetzt), weil sie im
 *   Nutzer-Home neben DB, Bare-Repo und Volumes liegt.
 */
export function envZielPfad(opts: {
  istDevCheckout: boolean;
  repoRoot: string;
  macvibesHome: string;
}): string {
  return opts.istDevCheckout
    ? join(opts.repoRoot, 'apps', 'server', '.env')
    : join(opts.macvibesHome, '.env');
}

/**
 * Aussperr-Absicherung des Sandbox-Backends: msb vorhanden → voller VM-Modus
 * (microsandbox), sonst der klar benannte Prozess-Fallback statt eines toten
 * Zustands (installer-plan.md, Schritt 5).
 */
export function sandboxModeFor(msbAvailable: boolean): 'microsandbox' | 'process' {
  return msbAvailable ? 'microsandbox' : 'process';
}

/** Injizierte Prüf-Ergebnisse für den Doctor (keine Syscalls in doctor()). */
export interface DoctorInput {
  /** Laufende Bun-Version (Bun.version) oder null, wenn bun fehlt. */
  bunVersion: string | null;
  /** Erwarteter Pin (CLAUDE.md: 1.3.14). */
  bunPin: string;
  gitAvailable: boolean;
  msbAvailable: boolean;
  /**
   * Ist ein Hypervisor (HVF auf Apple Silicon) nutzbar? null = nicht geprüft.
   * Nur relevant, wenn msb da ist — ohne msb bootet ohnehin keine VM.
   */
  hypervisorAvailable: boolean | null;
  /** Belegte der geprüften Ports (Server/Egress/Web/Gateway). */
  belegtePorts: number[];
}

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  id: 'bun' | 'git' | 'msb' | 'hypervisor' | 'ports';
  label: string;
  status: DoctorStatus;
  /** Umsetzbarer Hinweis (was tun?) — bei 'ok' knapp/leer. */
  hinweis: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** Mindestens ein 'fail' — das Setup darf nicht weiterlaufen. */
  hatFehler: boolean;
  /** Mindestens ein 'warn' — Setup läuft weiter, aber mit Hinweisen. */
  hatWarnung: boolean;
}

/**
 * Reine Auswertung der Doctor-Eingaben. Leitregel (installer-plan.md): nur
 * echte Blocker sind `fail` (ohne bun/git geht gar nichts). Fehlendes msb/
 * Hypervisor ist `warn`, weil der Prozess-Fallback existiert — das Setup soll
 * niemanden aussperren.
 */
export function doctor(input: DoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [];

  // bun
  if (input.bunVersion === null) {
    checks.push({
      id: 'bun',
      label: 'Bun-Laufzeit',
      status: 'fail',
      hinweis: `bun nicht gefunden — installieren und auf ${input.bunPin} pinnen (mac: brew install oven-sh/bun/bun && brew pin bun).`,
    });
  } else if (input.bunVersion !== input.bunPin) {
    checks.push({
      id: 'bun',
      label: 'Bun-Laufzeit',
      status: 'warn',
      hinweis: `Bun ${input.bunVersion} weicht vom Pin ${input.bunPin} ab — macvibes ist auf ${input.bunPin} getestet (Sandbox-/Agent-Pfade). Nur bewusst upgraden.`,
    });
  } else {
    checks.push({ id: 'bun', label: 'Bun-Laufzeit', status: 'ok', hinweis: input.bunVersion });
  }

  // git
  checks.push(
    input.gitAvailable
      ? { id: 'git', label: 'git', status: 'ok', hinweis: '' }
      : {
          id: 'git',
          label: 'git',
          status: 'fail',
          hinweis:
            'git fehlt — für die Projekt-Branches im Bare-Repo nötig (mac: brew install git).',
        },
  );

  // msb (microsandbox)
  checks.push(
    input.msbAvailable
      ? { id: 'msb', label: 'microsandbox (msb)', status: 'ok', hinweis: '' }
      : {
          id: 'msb',
          label: 'microsandbox (msb)',
          status: 'warn',
          hinweis:
            'msb fehlt — Setup nutzt den Prozess-Modus (ohne VM-Isolat, nur Dev). Voller VM-Modus: brew install superradcompany/tap/microsandbox, dann bun run baselines.',
        },
  );

  // Hypervisor — nur relevant, wenn msb da ist.
  if (!input.msbAvailable) {
    checks.push({
      id: 'hypervisor',
      label: 'Hypervisor (HVF)',
      status: 'ok',
      hinweis: 'übersprungen (kein msb — es bootet ohnehin keine VM).',
    });
  } else if (input.hypervisorAvailable === true) {
    checks.push({ id: 'hypervisor', label: 'Hypervisor (HVF)', status: 'ok', hinweis: '' });
  } else {
    checks.push({
      id: 'hypervisor',
      label: 'Hypervisor (HVF)',
      status: 'warn',
      hinweis:
        input.hypervisorAvailable === false
          ? 'Kein Hypervisor (HVF) verfügbar — MicroVMs können nicht booten; es greift der Prozess-Fallback.'
          : 'Hypervisor-Status unbekannt — falls MicroVMs nicht booten, hilft der Prozess-Modus (MACVIBES_SANDBOX=process).',
    });
  }

  // Ports
  checks.push(
    input.belegtePorts.length === 0
      ? { id: 'ports', label: 'Ports frei', status: 'ok', hinweis: '' }
      : {
          id: 'ports',
          label: 'Ports frei',
          status: 'warn',
          hinweis: `Belegt: ${input.belegtePorts.map((p) => `:${p}`).join(' ')} — läuft macvibes schon? Erst: bun run shutdown. Ports (${input.belegtePorts.join(', ')}) freimachen.`,
        },
  );

  return {
    checks,
    hatFehler: checks.some((c) => c.status === 'fail'),
    hatWarnung: checks.some((c) => c.status === 'warn'),
  };
}
