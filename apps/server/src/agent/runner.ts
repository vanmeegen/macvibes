import type { AgentEvent } from './events';

export interface TurnOptions {
  projectId: string;
  prompt: string;
  workspaceDir: string;
  /** Claude-Session zum Fortsetzen (`--resume`) — null für die erste Nachricht. */
  resumeSessionId: string | null;
  /** Modell für diesen Turn (Modellwahl pro Chat/Projekt, s. agentModel.ts). */
  model: string;
}

export interface TurnHandle {
  events: AsyncIterable<AgentEvent>;
  /**
   * Bricht den laufenden Turn ab. Zusagen jeder Implementierung:
   *
   * - Der Event-Strom endet danach mit `turn-aborted`. Ohne dieses Ereignis
   *   wartet der Aufrufer bis in seinen Watchdog-Timeout.
   * - Die Claude-Sitzung bleibt INTAKT: abgebrochen wird der Turn, nicht der
   *   Agent. Ein Prozess-Kill hinterliesse eine korrupte Sitzung, die jeder
   *   folgende `--resume` wieder aufgreift (chatproblems.md #13) — deshalb ist
   *   der Produktivpfad ein SDK-`interrupt()`.
   * - Mehrfachaufruf und Aufruf nach Turn-Ende sind folgenlos.
   *
   * ⚠️ Wer `abort()` aufruft, entscheidet damit AUCH über den Retry — siehe
   * `ChatService.runAttempt`: dort liegt hinter `state.currentHandle` ein
   * umhülltes Handle, dessen `abort()` den Turn als Nutzerabbruch markiert und
   * damit endgültig beendet.
   */
  abort(): void;
}

/**
 * Abstraktion über den Coding-Agenten. Implementierungen:
 * ClaudeAgentRunner (Claude Agent SDK) und FakeAgentRunner (Tests/E2E).
 */
export interface AgentRunner {
  startTurn(options: TurnOptions): TurnHandle;
}
