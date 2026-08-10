/**
 * Modellkatalog für den Agenten (Claude Code). Jeder Chat/jedes Projekt wählt
 * sein Modell selbst (Dropdown im Chat, persistiert auf dem Projekt); neue
 * Projekte starten mit dem Default (Claude Sonnet 5).
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
  /** Modell-ID, wie sie an die API/den Router geht (z. B. "claude-sonnet-5"). */
  id: string;
  /** Anzeigename fürs Dropdown. */
  label: string;
  /** Lokales (langsames) Modell → großzügige Turn-Timeouts. */
  slow: boolean;
}

/**
 * Eingebauter Katalog. Eigene Modelle (OpenRouter / OpenAI / eigener Endpunkt)
 * gehören NICHT hierher, sondern in `<macvibesHome>/models.json` (Default
 * `~/macvibes/models.json`) — dieselbe Form als JSON-Array:
 *   [{ "id": "openrouter/qwen/qwen3-coder", "label": "Qwen3 Coder", "slow": true }]
 * Der Quellcode liegt bei einer Installation (Homebrew) in libexec und wird
 * bei jedem Upgrade ersetzt — nur die Home-Datei überlebt das. Das Modell muss
 * zusätzlich im LiteLLM-Router als `model_name` geführt sein (s. README,
 * „Andere Modelle").
 */
export const AGENT_MODELS: readonly AgentModelInfo[] = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', slow: false },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', slow: false },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', slow: false },
  { id: 'qwen3.6-coder', label: 'Qwen 27B (lokal)', slow: true },
  { id: 'qwen3.6-moe', label: 'Qwen 35B MoE (lokal)', slow: true },
];

/**
 * Default für neue Chats/Projekte. Bewusst FEST (kein Env-Override): das Modell
 * wird pro Chat im Dropdown gewählt; ein globaler Schalter würde nur wieder
 * versteckte Zustände schaffen (und Tests von der lokalen .env abhängig machen).
 */
export const DEFAULT_AGENT_MODEL = 'claude-sonnet-5';

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
          'routet sie an die Anthropic-API statt an den lokalen Router. Übersprungen.',
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

/** Vollständiger Katalog fürs Dropdown: eingebaute zuerst, dann Nutzer-Modelle. */
export function allAgentModels(): readonly AgentModelInfo[] {
  return [...AGENT_MODELS, ...userAgentModels];
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
