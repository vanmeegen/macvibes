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

export interface AgentModelInfo {
  /** Modell-ID, wie sie an die API/den Router geht (z. B. "claude-sonnet-5"). */
  id: string;
  /** Anzeigename fürs Dropdown. */
  label: string;
  /** Lokales (langsames) Modell → großzügige Turn-Timeouts. */
  slow: boolean;
}

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

export function isKnownAgentModel(id: string): boolean {
  return AGENT_MODELS.some((m) => m.id === id);
}

export function isSlowAgentModel(id: string): boolean {
  return AGENT_MODELS.find((m) => m.id === id)?.slow ?? false;
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
