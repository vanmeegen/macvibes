/**
 * Das Modell, mit dem der Agent (Claude Code) in der VM läuft. Sonnet 5 denkt
 * für dieselbe Aufgabe deutlich ausführlicher „laut" als Opus — der Live-Denk-
 * Stream (💭) ist dadurch gehaltvoller.
 *
 * WICHTIG: Eine Claude-Code-Session darf NICHT über einen Modellwechsel hinweg
 * fortgesetzt werden (`--resume` + anderes `--model` bringt den Agenten zum
 * Hängen). Der ChatService gleicht dieses Modell mit dem der gespeicherten
 * Session ab und startet bei Abweichung (oder unbekanntem Modell) frisch.
 */
export const AGENT_MODEL = 'claude-sonnet-5';
