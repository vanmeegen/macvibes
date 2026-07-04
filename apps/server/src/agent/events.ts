/** Strukturierte Events eines Agent-Turns — Grundlage für Streaming + Persistenz (R6). */
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'block-stop' }
  | { type: 'tool-use'; name: string; detail: string }
  | { type: 'session'; sessionId: string }
  | { type: 'api-retry'; attempt: number; maxRetries: number; message: string }
  | { type: 'turn-completed'; sessionId: string | null }
  | { type: 'turn-aborted' }
  | { type: 'error'; message: string };
