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

    const stream = query({
      prompt: options.prompt,
      options: {
        cwd: options.workspaceDir,
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
