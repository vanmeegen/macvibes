import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from './events';
import type { AgentRunner, TurnHandle, TurnOptions } from './runner';

/**
 * Treibt Claude Code über das Agent SDK im Projekt-Workspace.
 * Volle Autonomie (bypassPermissions) — die Isolation leistet die Sandbox.
 * Transiente API-Fehler behandelt das SDK selbst per Retry/Backoff (R6).
 */
export class ClaudeAgentRunner implements AgentRunner {
  startTurn(options: TurnOptions): TurnHandle {
    const abortController = new AbortController();

    // Schwächere lokale Modelle kündigen Arbeit oft nur an, statt Tools aufzurufen —
    // diese Anweisung drängt zum direkten Handeln. Für Claude ein harmloses No-Op.
    const appendSystemPrompt =
      Bun.env.MACVIBES_AGENT_APPEND_PROMPT ??
      `WICHTIG (macvibes): Kündige Änderungen nicht nur an, sondern rufe sofort die ` +
        `passenden Tools (Write/Edit) im aktuellen Arbeitsverzeichnis auf und führe sie aus.`;

    const stream = query({
      prompt: options.prompt,
      options: {
        cwd: options.workspaceDir,
        model: options.model,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: appendSystemPrompt },
        // Projekt-Memory (AGENTS.md/CLAUDE.md) aus dem Workspace laden.
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        abortController,
        ...(options.resumeSessionId !== null ? { resume: options.resumeSessionId } : {}),
      },
    });

    const events = (async function* (): AsyncGenerator<AgentEvent> {
      let sessionId: string | null = null;
      try {
        for await (const message of stream) {
          switch (message.type) {
            case 'system':
              if (message.subtype === 'init') {
                sessionId = message.session_id;
              }
              break;
            case 'stream_event': {
              const event = message.event;
              if (
                event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta' &&
                event.delta.text.length > 0
              ) {
                yield { type: 'text-delta', text: event.delta.text };
              }
              break;
            }
            case 'assistant':
              for (const block of message.message.content) {
                if (block.type === 'tool_use') {
                  yield {
                    type: 'tool-use',
                    name: block.name,
                    detail: JSON.stringify(block.input).slice(0, 300),
                  };
                }
              }
              break;
            case 'result':
              sessionId = message.session_id ?? sessionId;
              if (message.subtype === 'success') {
                yield { type: 'turn-completed', sessionId };
              } else {
                yield { type: 'error', message: `Agent-Turn fehlgeschlagen (${message.subtype})` };
                yield { type: 'turn-aborted' };
              }
              break;
            default:
              break;
          }
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          yield { type: 'turn-aborted' };
        } else {
          yield {
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          };
          yield { type: 'turn-aborted' };
        }
      }
    })();

    return {
      events,
      abort: () => abortController.abort(),
    };
  }
}
