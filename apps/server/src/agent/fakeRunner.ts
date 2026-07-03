import type { AgentEvent } from './events';
import type { AgentRunner, TurnHandle, TurnOptions } from './runner';

/**
 * Deterministischer Agent für Tests und E2E (MACVIBES_AGENT=fake):
 * antwortet mit "Echo: <prompt>" als Wort-Stream. Spezielle Prompts:
 * enthält "FEHLER" → error-Event; enthält "LANGSAM" → langer Turn (für Stop-Tests).
 */
export class FakeAgentRunner implements AgentRunner {
  constructor(private readonly delayMs: number = 5) {}

  startTurn(options: TurnOptions): TurnHandle {
    let aborted = false;
    const delayMs = this.delayMs;

    const events = (async function* (): AsyncGenerator<AgentEvent> {
      if (options.prompt.includes('FEHLER')) {
        yield { type: 'error', message: 'Simulierter API-Fehler (Fake-Agent)' };
        yield { type: 'turn-aborted' };
        return;
      }

      yield { type: 'tool-use', name: 'FakeTool', detail: `arbeitet in ${options.workspaceDir}` };

      for (const word of `Echo: ${options.prompt}`.split(' ')) {
        if (aborted) {
          yield { type: 'turn-aborted' };
          return;
        }
        await Bun.sleep(delayMs);
        yield { type: 'text-delta', text: `${word} ` };
      }

      const slowRounds = options.prompt.includes('LANGSAM') ? 400 : 0;
      for (let i = 0; i < slowRounds; i += 1) {
        if (aborted) {
          yield { type: 'turn-aborted' };
          return;
        }
        await Bun.sleep(delayMs);
      }

      yield { type: 'turn-completed', sessionId: 'fake-session' };
    })();

    return {
      events,
      abort: () => {
        aborted = true;
      },
    };
  }
}
