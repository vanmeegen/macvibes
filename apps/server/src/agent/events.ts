/** Strukturierte Events eines Agent-Turns — Grundlage für Streaming + Persistenz (R6). */
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-use'; name: string; detail: string }
  | { type: 'turn-completed'; sessionId: string | null }
  | { type: 'turn-aborted' }
  | { type: 'error'; message: string };
