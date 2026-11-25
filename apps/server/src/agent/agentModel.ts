/**
 * Modellkatalog für den Agenten (Claude Code). Jeder Chat/jedes Projekt wählt
 * sein Modell selbst (Dropdown im Chat, persistiert auf dem Projekt); neue
 * Projekte starten mit dem Default (Claude Sonnet 5.5).
 *
 * `slow` markiert lokale Modelle: sie „denken" vor dem ersten sichtbaren Token
 * deutlich länger — der ChatService nutzt dafür großzügigere Timeouts.
 *
 * WICHTIG: Eine Claude-Code-Session darf NICHT über einen Modellwechsel hinweg
 * fortgesetzt werden (`--resume` + anderes `--model` bringt den Agenten zum
 * Hängen). Der ChatService gleicht das Projekt-Modell mit dem der gespeicherten
 * Session ab und startet bei Abweichung (oder unbekanntem Modell) frisch.
 */
import { existsSync, readFileSync } from 'node:fs';

export interface AgentModelInfo {
  /** Modell-ID, wie sie an die API/den Router geht (z. B. "claude-sonnet-5-5"). */
  id: string;
  /** Anzeigename fürs Dropdown. */
  label: string;
  /** Lokales (langsames) Modell → großzügige Turn-Timeouts. */
  slow: boolean;
  /**
   * Steht im Dropdown ganz unten, auch hinter den Nutzer-Modellen — für
   * Modelle, die man nicht versehentlich wählen soll (sehr teuer).
   */
  zuletzt?: true;
}

/**
 * Eingebaute Anthropic-Modelle — der Stand, der ohne Konfiguration gilt. Die
 * Liste ist KONFIGURATION: `<macvibesHome>/claude-models.json` (Default
 * `~/macvibes/claude-models.json`) ersetzt sie vollständig, ohne Neubau:
 *   [
 *     { "id": "claude-sonnet-5-5", "label": "Claude Sonnet 5.5" },
 *     { "id": "claude-fable-5-2", "label": "Claude Fable 5.2 *", "zuletzt": true }
 *   ]
 * Der ERSTE Eintrag ist der Default für neue Projekte. Die id geht unverändert
 * an die Anthropic-API (der Credential-Proxy routet alles mit `claude`-Präfix
 * dorthin). Gelesen wird die Datei beim Serverstart.
 */
const BUILTIN_CLAUDE_MODELS: readonly AgentModelInfo[] = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', slow: false },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', slow: false },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', slow: false },
  // Mit Abstand das teuerste Modell: Sternchen und Warnung stehen im Namen,
  // damit sie in jeder Ansicht der Liste sichtbar sind, und der Eintrag bleibt
  // ganz unten (s. allAgentModels).
  {
    id: 'claude-fable-5-2',
    label: 'Claude Fable 5.2 * — Achtung, sehr teuer',
    slow: false,
    zuletzt: true,
  },
];

/**
 * Das lokale Modell bleibt Code, nicht Konfiguration: an ihm hängen der
 * Modell-Server (oMLX) und das Routing im Credential-Proxy.
 *
 * Qwen3.8-27B (oQ4e + Lightning MTP) auf oMLX — die id ist exakt der
 * Modellname, den oMLX unter /v1/models führt (Verzeichnisname in
 * ~/.omlx/models). Der Credential-Proxy schickt alles ohne claude-Präfix an
 * MACVIBES_LOCAL_UPSTREAM_URL (Default: oMLX, http://localhost:8000).
 */
const LOCAL_MODELS: readonly AgentModelInfo[] = [
  { id: 'Qwen3.8-27B-oQ4e-mtp', label: 'Qwen 3.8 27B (lokal, oMLX)', slow: true },
];

/** Dropdown-Reihenfolge: normale Einträge, dann `mitte`, ganz unten `zuletzt`. */
function sortiert(
  claude: readonly AgentModelInfo[],
  mitte: readonly AgentModelInfo[],
): readonly AgentModelInfo[] {
  return [
    ...claude.filter((m) => m.zuletzt !== true),
    ...mitte,
    ...claude.filter((m) => m.zuletzt === true),
  ];
}

/**
 * Eingebauter Katalog (Anthropic-Modelle + lokales Modell) in der Reihenfolge
 * des Dropdowns. Weitere Modelle (OpenRouter / OpenAI / eigener Endpunkt)
 * gehören NICHT hierher, sondern in `<macvibesHome>/models.json` (Default
 * `~/macvibes/models.json`) — dieselbe Form als JSON-Array:
 *   [{ "id": "openrouter/qwen/qwen3-coder", "label": "Qwen3 Coder", "slow": true }]
 * Der Quellcode liegt bei einer Installation (Homebrew) in libexec und wird
 * bei jedem Upgrade ersetzt — nur die Home-Dateien überleben das. Ein solches
 * Modell muss zusätzlich ROUTBAR sein: über eine Route in MACVIBES_MODEL_ROUTES
 * (Anthropic-kompatibler Endpunkt direkt oder die LiteLLM-Bridge, dort dann
 * als `model_name` geführt) — `bun run setup` verdrahtet beides (s. README,
 * „Andere Modelle").
 */
export const AGENT_MODELS: readonly AgentModelInfo[] = sortiert(
  BUILTIN_CLAUDE_MODELS,
  LOCAL_MODELS,
);

/**
 * Eingebauter Default für neue Chats/Projekte — das erste eingebaute
 * Anthropic-Modell. Der WIRKSAME Default kommt aus `defaultAgentModel()`
 * (erster Eintrag der claude-models.json, falls vorhanden). Bewusst kein
 * Env-Override: ein globaler Schalter neben der Liste wäre ein zweiter Ort
 * für dieselbe Entscheidung.
 */
export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5-5';

export interface ClaudeModelParseResult {
  models: AgentModelInfo[];
  warnings: string[];
}

/**
 * Validiert den Inhalt von `<macvibesHome>/claude-models.json`. Wie bei
 * `parseUserAgentModels`: kaputte Einträge werden übersprungen und gemeldet,
 * geworfen wird nie — eine vertippte Datei darf den Serverstart nicht
 * verhindern.
 */
export function parseClaudeModels(raw: string): ClaudeModelParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { models: [], warnings: [`claude-models.json ist kein gültiges JSON: ${error}`] };
  }
  if (!Array.isArray(parsed)) {
    return {
      models: [],
      warnings: ['claude-models.json muss ein JSON-Array von {id, label} sein.'],
    };
  }
  const warnings: string[] = [];
  const models: AgentModelInfo[] = [];
  for (const [index, entry] of parsed.entries()) {
    const wo = `claude-models.json[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(`${wo}: kein Objekt — übersprungen.`);
      continue;
    }
    const { id, label, zuletzt } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.trim() === '') {
      warnings.push(`${wo}: "id" fehlt oder ist kein nichtleerer String — übersprungen.`);
      continue;
    }
    if (typeof label !== 'string' || label.trim() === '') {
      warnings.push(
        `${wo} ("${id}"): "label" fehlt oder ist kein nichtleerer String — übersprungen.`,
      );
      continue;
    }
    // Gegenstück zur Regel in models.json: nur ids mit "claude"-Präfix routet
    // der Credential-Proxy an die Anthropic-API. Alles andere liefe an den
    // lokalen Router und gehört in models.json.
    if (!id.startsWith('claude')) {
      warnings.push(
        `${wo} ("${id}"): keine Anthropic-Modell-id (Präfix "claude" fehlt) — andere Modelle gehören in models.json. Übersprungen.`,
      );
      continue;
    }
    if (zuletzt !== undefined && typeof zuletzt !== 'boolean') {
      warnings.push(`${wo} ("${id}"): "zuletzt" muss true oder false sein — übersprungen.`);
      continue;
    }
    if (models.some((m) => m.id === id)) {
      warnings.push(`${wo} ("${id}"): doppelte id — erster Eintrag gewinnt.`);
      continue;
    }
    models.push({ id, label, slow: false, ...(zuletzt === true ? { zuletzt: true } : {}) });
  }
  return { models, warnings };
}

/**
 * Prozessweite Anthropic-Liste aus der Konfiguration; `null` = eingebaute
 * Liste. Modul-Zustand aus demselben Grund wie `userAgentModels` weiter unten:
 * nach dem Start unveränderlich, befüllt genau einmal von der Composition Root.
 */
let configuredClaudeModels: readonly AgentModelInfo[] | null = null;

/** Setzt die Anthropic-Liste; `null` stellt die eingebaute wieder her (Test-Naht). */
export function registerClaudeModels(models: readonly AgentModelInfo[] | null): void {
  configuredClaudeModels = models === null ? null : [...models];
}

function claudeModels(): readonly AgentModelInfo[] {
  return configuredClaudeModels ?? BUILTIN_CLAUDE_MODELS;
}

/**
 * Lädt `<macvibesHome>/claude-models.json` (falls vorhanden) und ersetzt damit
 * die eingebauten Anthropic-Modelle. Fehlende Datei ist der Normalfall. Eine
 * Datei ohne einen einzigen gültigen Eintrag lässt die eingebaute Liste
 * stehen — ein Dropdown ohne Anthropic-Modell wäre nie gewollt. Gibt die Zahl
 * der übernommenen Modelle zurück.
 */
export function loadClaudeModels(
  filePath: string,
  warn: (message: string) => void = console.warn,
): number {
  registerClaudeModels(null);
  if (!existsSync(filePath)) return 0;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    warn(`Anthropic-Modelle ${filePath} nicht lesbar — eingebaute Liste gilt: ${error}`);
    return 0;
  }
  const { models, warnings } = parseClaudeModels(raw);
  for (const warning of warnings) warn(`Anthropic-Modelle (${filePath}): ${warning}`);
  if (models.length === 0) {
    warn(`Anthropic-Modelle (${filePath}): kein gültiger Eintrag — die eingebaute Liste gilt.`);
    return 0;
  }
  registerClaudeModels(models);
  return models.length;
}

/** Wirksamer Default für neue Projekte: das erste Anthropic-Modell der Liste. */
export function defaultAgentModel(): string {
  return claudeModels()[0]?.id ?? DEFAULT_AGENT_MODEL;
}

/**
 * Das Modell, mit dem ein Projekt tatsächlich läuft: sein gespeichertes, wenn
 * es im Katalog steht, sonst der Default. So überlebt ein Projekt, dass sein
 * Modell aus der Liste genommen wurde, statt mit einem abgekündigten Modell an
 * der API zu scheitern.
 */
export function effectiveAgentModel(gespeichert: string | null | undefined): string {
  if (typeof gespeichert === 'string' && isKnownAgentModel(gespeichert)) return gespeichert;
  return defaultAgentModel();
}

export interface UserAgentModelParseResult {
  models: AgentModelInfo[];
  warnings: string[];
}

/**
 * Validiert den Inhalt von `<macvibesHome>/models.json` STRENG, aber tolerant
 * im Fehlerfall: kaputte Einträge werden übersprungen und als Warnung gemeldet,
 * geworfen wird NIE — der Katalog ist Beschleuniger, kein Muss, und eine
 * vertippte Nutzerdatei darf den Serverstart nicht verhindern.
 */
export function parseUserAgentModels(raw: string): UserAgentModelParseResult {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      models: [],
      warnings: [`models.json ist kein gültiges JSON — alle Nutzer-Modelle ignoriert: ${error}`],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      models: [],
      warnings: ['models.json muss ein JSON-Array von {id, label, slow} sein — ignoriert.'],
    };
  }
  const models: AgentModelInfo[] = [];
  for (const [index, entry] of parsed.entries()) {
    const wo = `models.json[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      warnings.push(`${wo}: kein Objekt — übersprungen.`);
      continue;
    }
    const { id, label, slow } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.trim() === '') {
      warnings.push(`${wo}: "id" fehlt oder ist kein nichtleerer String — übersprungen.`);
      continue;
    }
    if (typeof label !== 'string' || label.trim() === '') {
      warnings.push(
        `${wo} ("${id}"): "label" fehlt oder ist kein nichtleerer String — übersprungen.`,
      );
      continue;
    }
    if (typeof slow !== 'boolean') {
      warnings.push(`${wo} ("${id}"): "slow" fehlt oder ist kein Boolean — übersprungen.`);
      continue;
    }
    // ECHTE FALLE, kein Stilverbot: der Credential-Proxy routet pro Request
    // nach dem Modellnamen im Body, und das Präfix "claude" geht IMMER an die
    // Anthropic-API (http/anthropicProxy) — ein Nutzer-Modell "claude-…" käme
    // also nie beim lokalen Router an und schiene nur „kaputt".
    if (id.startsWith('claude')) {
      warnings.push(
        `${wo} ("${id}"): ids mit "claude"-Präfix sind reserviert — der Credential-Proxy ` +
          'routet sie an die Anthropic-API statt an den lokalen Router. Anthropic-Modelle ' +
          'gehören in claude-models.json. Übersprungen.',
      );
      continue;
    }
    // Eingebaute Modelle sind nicht überschreibbar: sonst könnte ein
    // Nutzer-Eintrag z. B. ein eingebautes Modell als „schnell" umdeklarieren
    // und damit dessen Timeout-Verhalten kippen.
    if (AGENT_MODELS.some((m) => m.id === id)) {
      warnings.push(
        `${wo} ("${id}"): kollidiert mit einem eingebauten Modell — eingebauter Eintrag gewinnt.`,
      );
      continue;
    }
    if (models.some((m) => m.id === id)) {
      warnings.push(`${wo} ("${id}"): doppelte id in models.json — erster Eintrag gewinnt.`);
      continue;
    }
    models.push({ id, label, slow });
  }
  return { models, warnings };
}

/**
 * Prozessweiter Nutzer-Anteil des Katalogs. Bewusst Modul-Zustand statt
 * Dependency Injection: der Katalog ist — wie die eingebaute Konstante darüber
 * — nach dem Start unveränderlich und wird von drei Schichten (schema,
 * services, agent) über dieselben Hilfsfunktionen konsumiert; ein Katalog-
 * Parameter durch alle Signaturen wäre Churn ohne Gewinn. Befüllt wird er
 * GENAU EINMAL von der Composition Root (index.ts) über loadUserAgentModels —
 * der Seiteneffekt (Dateizugriff aufs Nutzer-Home) sitzt damit am Rand, nicht
 * im Modul-Import (sonst hinge jeder Unit-Test von der Maschine ab, s. das
 * gleiche Argument bei homeEnvPathFor in config.ts).
 */
let userAgentModels: readonly AgentModelInfo[] = [];

/** Ersetzt (nicht ergänzt) die Nutzer-Modelle — auch die Test-Rücksetz-Naht. */
export function registerUserAgentModels(models: readonly AgentModelInfo[]): void {
  userAgentModels = [...models];
}

/**
 * Vollständiger Katalog fürs Dropdown: Anthropic-Modelle, das lokale Modell,
 * Nutzer-Modelle — und ganz unten die als `zuletzt` markierten (das teure
 * Fable).
 */
export function allAgentModels(): readonly AgentModelInfo[] {
  return sortiert(claudeModels(), [...LOCAL_MODELS, ...userAgentModels]);
}

/**
 * Lädt `<macvibesHome>/models.json` (falls vorhanden) und registriert die
 * gültigen Einträge. Fehlende Datei ist der Normalfall (kein Hinweis nötig);
 * jede andere Panne wird gemeldet, wirft aber nie. Gibt die Zahl der geladenen
 * Modelle zurück, damit die Composition Root den Erfolg loggen kann.
 */
export function loadUserAgentModels(
  filePath: string,
  warn: (message: string) => void = console.warn,
): number {
  registerUserAgentModels([]);
  if (!existsSync(filePath)) return 0;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    warn(`Nutzer-Modelle ${filePath} nicht lesbar — übersprungen: ${error}`);
    return 0;
  }
  const { models, warnings } = parseUserAgentModels(raw);
  for (const warning of warnings) warn(`Nutzer-Modelle (${filePath}): ${warning}`);
  registerUserAgentModels(models);
  return models.length;
}

export function isKnownAgentModel(id: string): boolean {
  return allAgentModels().some((m) => m.id === id);
}

export function isSlowAgentModel(id: string): boolean {
  return allAgentModels().find((m) => m.id === id)?.slow ?? false;
}

export interface AgentTimeouts {
  idleMs: number;
  firstEventMs: number;
  coldStartMs: number;
}

/**
 * Wählt die Turn-Timeouts nach Modellklasse. Unbekannte Modelle (z. B. über
 * Zusatz-Routen des Routers ergänzt) werden konservativ als LANGSAM behandelt —
 * lieber geduldig warten als ein träges Fremdmodell sofort abzubrechen.
 */
export function agentTimeoutsFor(
  model: string,
  fast: AgentTimeouts,
  slow: AgentTimeouts,
): AgentTimeouts {
  if (!isKnownAgentModel(model)) return slow;
  return isSlowAgentModel(model) ? slow : fast;
}
