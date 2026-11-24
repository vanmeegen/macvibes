import { describe, expect, test } from 'bun:test';
import { eventsFromSdkStream } from '../claudeRunner';
import type { AgentEvent } from '../events';

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function* streamOf(...messages: unknown[]): AsyncGenerator<unknown> {
  for (const message of messages) yield message;
}

/**
 * Der Host-Runner (Dev ohne msb) hatte eine eigene, abgedriftete Abbildung der
 * SDK-Messages: keine session-/thinking-/block-stop-/api-retry-Events, Tools
 * erst aus dem fertigen assistant-Block. Dev verhielt sich dadurch anders als
 * der VM-Daemon. Jetzt nutzen beide agentEventsFromMessage.
 */
describe('eventsFromSdkStream — Host-Runner bildet wie der VM-Daemon ab', () => {
  test('liefert dieselben Events wie der Daemon-Pfad (session, thinking, block-stop, tool live)', async () => {
    const events = await collect(
      eventsFromSdkStream(
        streamOf(
          { type: 'system', subtype: 'init', session_id: 's-1' },
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'thinking_delta', thinking: 'hm' },
            },
          },
          { type: 'stream_event', event: { type: 'content_block_stop' } },
          {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              content_block: { type: 'tool_use', name: 'Write' },
            },
          },
          // Der fertige assistant-Block darf das Tool NICHT ein zweites Mal melden.
          {
            type: 'assistant',
            message: { content: [{ type: 'tool_use', name: 'Write', input: { a: 1 } }] },
          },
          {
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fertig' } },
          },
          { type: 'result', subtype: 'success', session_id: 's-1' },
        ),
        () => false,
      ),
    );
    expect(events).toEqual([
      { type: 'session', sessionId: 's-1' },
      { type: 'thinking-delta', text: 'hm' },
      { type: 'block-stop' },
      { type: 'tool-use', name: 'Write', detail: '' },
      { type: 'text-delta', text: 'fertig' },
      { type: 'turn-completed', sessionId: 's-1' },
    ]);
  });

  test('api_retry wird gemeldet statt verschluckt', async () => {
    const events = await collect(
      eventsFromSdkStream(
        streamOf({
          type: 'system',
          subtype: 'api_retry',
          error: 'overloaded',
          attempt: 1,
          max_retries: 3,
        }),
        () => false,
      ),
    );
    expect(events).toEqual([
      { type: 'api-retry', attempt: 1, maxRetries: 3, message: 'overloaded' },
    ]);
  });

  test('wirft der Stream nach einem Abbruch, endet der Turn als turn-aborted ohne Fehlermeldung', async () => {
    async function* kaputt(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: 's-2' };
      throw new Error('aborted by user');
    }
    const events = await collect(eventsFromSdkStream(kaputt(), () => true));
    expect(events).toEqual([{ type: 'session', sessionId: 's-2' }, { type: 'turn-aborted' }]);
  });

  test('wirft der Stream ohne Abbruch, kommt die Fehlermeldung vor turn-aborted', async () => {
    const kaputt: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('SDK kaputt')) }),
    };
    const events = await collect(eventsFromSdkStream(kaputt, () => false));
    expect(events).toEqual([{ type: 'error', message: 'SDK kaputt' }, { type: 'turn-aborted' }]);
  });
});
