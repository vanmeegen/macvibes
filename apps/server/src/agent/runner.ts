import type { AgentEvent } from './events';

export interface TurnOptions {
  prompt: string;
  workspaceDir: string;
  /** Claude-Session zum Fortsetzen (`--resume`) — null für die erste Nachricht. */
  resumeSessionId: string | null;
}

export interface TurnHandle {
  events: AsyncIterable<AgentEvent>;
  abort(): void;
}

/**
 * Abstraktion über den Coding-Agenten. Implementierungen:
 * ClaudeAgentRunner (Claude Agent SDK) und FakeAgentRunner (Tests/E2E).
 */
export interface AgentRunner {
  startTurn(options: TurnOptions): TurnHandle;
}
