import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { AGENT_MODEL } from '../../agent/agentModel';
import { FakeAgentRunner } from '../../agent/fakeRunner';
import type { AgentEvent } from '../../agent/events';
import type { AgentRunner, TurnHandle, TurnOptions } from '../../agent/runner';
import type { Db } from '../../db/client';
import { projects, type UserRow } from '../../db/schema';
import { ChatService, type ChatEventPayload } from '../chatService';
import { createTestDb, createUser } from './testUtils';

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error('waitFor: Bedingung nicht erfüllt');
}

async function createProjectRow(db: Db, owner: UserRow, id = 'projekt-1'): Promise<string> {
  await db.insert(projects).values({
    id,
    name: `Projekt ${id}`,
    branchName: `${owner.username}/${id}`,
    templateDir: 'pwa',
    devCommand: 'bun run dev',
    previewPort: 5173,
    ownerId: owner.id,
  });
  return id;
}

interface TestSetup {
  db: Db;
  service: ChatService;
  projectId: string;
  turnEnds: string[];
  activity: string[];
}

async function setup(
  runner?: AgentRunner,
  agentIdleTimeoutMs?: number,
  agentAbortGraceMs?: number,
  agentFirstEventTimeoutMs?: number,
): Promise<TestSetup> {
  const db = createTestDb();
  const owner = await createUser(db, 'marco');
  const projectId = await createProjectRow(db, owner);
  const turnEnds: string[] = [];
  const activity: string[] = [];
  const service = new ChatService(
    db,
    runner ?? new FakeAgentRunner(1),
    {
      onAgentActivity: (id) => activity.push(id),
      onTurnEnd: async (_id, prompt) => {
        turnEnds.push(prompt);
      },
    },
    { agentIdleTimeoutMs, agentAbortGraceMs, agentFirstEventTimeoutMs },
  );
  return { db, service, projectId, turnEnds, activity };
}

function sendInput(projectId: string, text: string) {
  return { projectId, workspaceDir: '/tmp/fake-workspace', resumeSessionId: null, text };
}

describe('Watchdog: stiller Hänger wird als Fehler sichtbar', () => {
  test('bricht ab und schreibt eine error-Zeile, wenn der Agent nicht reagiert', async () => {
    // Runner, der NIE ein Event liefert (VM-Hänger auf einem Netz-Call).
    let aborted = false;
    const stallingRunner: AgentRunner = {
      startTurn(): TurnHandle {
        // next() löst nie auf — exakt der VM-Hänger auf einem Netz-Call.
        const events: AsyncIterable<never> = {
          [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
        };
        return {
          events,
          abort: () => {
            aborted = true;
          },
        };
      },
    };
    const { service, projectId } = await setup(stallingRunner, 40, 40);
    await service.sendMessage(sendInput(projectId, 'Bau was Großes'));

    await waitFor(() => !service.isTurnActive(projectId), 3000);
    expect(aborted).toBe(true);
    const messages = await service.listMessages(projectId);
    const err = messages.find((m) => m.role === 'error');
    expect(err).toBeDefined();
    expect(err?.content.toLowerCase()).toContain('nicht reagiert');
  });

  test('liefert der abgebrochene Prozess noch eine Fehlermeldung, hängt sie an', async () => {
    // Nach dem Abort meldet der Runner (wie VmAgentRunner) noch einen stderr-Fehler.
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        let release: (() => void) | null = null;
        const events = (async function* () {
          // Erst hängen bis abort, dann noch einen Fehler mit Detail nachliefern.
          await new Promise<void>((r) => {
            release = r;
          });
          yield { type: 'error', message: 'claude: cannot reach api (ECONNREFUSED)' } as const;
          yield { type: 'turn-aborted' } as const;
        })();
        return { events, abort: () => release?.() };
      },
    };
    const { service, projectId } = await setup(runner, 40, 200);
    await service.sendMessage(sendInput(projectId, 'x'));
    await waitFor(() => !service.isTurnActive(projectId), 3000);
    const err = (await service.listMessages(projectId)).find((m) => m.role === 'error');
    expect(err?.content).toContain('ECONNREFUSED');
  });
});

describe('First-Event-Timeout: kaputter Start wird SCHNELL erkannt (nicht erst nach 180s)', () => {
  test('kein einziges Event nach firstEventTimeout => Abbruch + sofortiger Retry', async () => {
    let calls = 0;
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        calls += 1;
        if (calls === 1) {
          // Erststart liefert NIE etwas (msb-Flake) — muss nach firstEventTimeout sterben,
          // obwohl der (viel längere) Idle-Timeout noch lange nicht erreicht ist.
          const events: AsyncIterable<never> = {
            [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
          };
          return { events, abort: () => {} };
        }
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text-delta', text: 'ok' };
          yield { type: 'turn-completed', sessionId: 's' };
        })();
        return { events, abort: () => {} };
      },
    };
    // idle riesig (10s), firstEvent klein (50ms) — der Test bleibt nur schnell,
    // wenn wirklich der First-Event-Timeout greift.
    const { service, projectId } = await setup(runner, 10_000, 40, 50);
    const t0 = Date.now();
    await service.sendMessage(sendInput(projectId, 'x'));
    await waitFor(() => !service.isTurnActive(projectId), 5000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(calls).toBe(2);
  });

  test('nach dem ersten Event gilt der normale (längere) Idle-Timeout', async () => {
    // Ein Event kommt sofort, danach Pause LÄNGER als der First-Event-Timeout —
    // der Turn darf dadurch NICHT abgebrochen werden.
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text-delta', text: 'sofort da' };
          await new Promise((r) => setTimeout(r, 300));
          yield { type: 'text-delta', text: ' — und fertig' };
          yield { type: 'turn-completed', sessionId: 's' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { service, projectId } = await setup(runner, 10_000, 40, 50);
    await service.sendMessage(sendInput(projectId, 'x'));
    await waitFor(() => !service.isTurnActive(projectId), 5000);
    const messages = await service.listMessages(projectId);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('sofort da — und fertig');
    expect(messages.some((m) => m.role === 'error')).toBe(false);
  });
});

describe('Auto-Retry: stummer Agent-Start wird einmal neu versucht (msb-Flakiness)', () => {
  test('Versuch 1 stirbt ohne Events, Versuch 2 liefert — Turn wird trotzdem fertig', async () => {
    let calls = 0;
    const flakyRunner: AgentRunner = {
      startTurn(): TurnHandle {
        calls += 1;
        if (calls === 1) {
          // msb-Flake: Prozess stirbt sofort, ohne je ein Event zu liefern.
          const events = (async function* (): AsyncGenerator<AgentEvent> {
            yield { type: 'turn-aborted' };
          })();
          return { events, abort: () => {} };
        }
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text-delta', text: 'Klappt jetzt.' };
          yield { type: 'turn-completed', sessionId: 's2' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { service, projectId } = await setup(flakyRunner, 500, 40);
    await service.sendMessage(sendInput(projectId, 'Bau'));
    await waitFor(() => !service.isTurnActive(projectId));

    expect(calls).toBe(2);
    const messages = await service.listMessages(projectId);
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'Klappt jetzt.')).toBe(
      true,
    );
    // Der Retry ist transparent (Systemzeile), aber KEIN error.
    expect(messages.some((m) => m.role === 'system' && /zweiter versuch/i.test(m.content))).toBe(
      true,
    );
  });

  test('auch der Watchdog-Fall (gar keine Reaktion) wird einmal neu versucht', async () => {
    let calls = 0;
    const flakyRunner: AgentRunner = {
      startTurn(): TurnHandle {
        calls += 1;
        if (calls === 1) {
          const events: AsyncIterable<never> = {
            [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
          };
          return { events, abort: () => {} };
        }
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn-completed', sessionId: 's2' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { service, projectId } = await setup(flakyRunner, 40, 40);
    await service.sendMessage(sendInput(projectId, 'x'));
    await waitFor(() => !service.isTurnActive(projectId), 3000);
    expect(calls).toBe(2);
  });

  test('kein Retry, wenn der Agent schon sinnvoll gearbeitet hat (echter Abbruch)', async () => {
    let calls = 0;
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        calls += 1;
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text-delta', text: 'Ich fange an…' };
          yield { type: 'turn-aborted' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { service, projectId } = await setup(runner, 500, 40);
    await service.sendMessage(sendInput(projectId, 'x'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(calls).toBe(1);
  });
});

describe('Session-Resume nur bei gleichem Modell (Hänger-Schutz)', () => {
  /** Runner, der das übergebene resumeSessionId festhält und den Turn sofort beendet. */
  function capturingRunner(): { runner: AgentRunner; seen: () => string | null } {
    let captured: string | null = null;
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        captured = options.resumeSessionId;
        const events = (async function* () {
          yield { type: 'turn-completed', sessionId: 'neue-session' } as const;
        })();
        return { events, abort: () => {} };
      },
    };
    return { runner, seen: () => captured };
  }

  test('setzt das Modell beim Speichern der Session (frische Session)', async () => {
    const { db, service, projectId } = await setup(capturingRunner().runner);
    await service.sendMessage(sendInput(projectId, 'Bau'));
    await waitFor(() => !service.isTurnActive(projectId));
    const row = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
    expect(row?.claudeSessionId).toBe('neue-session');
    expect(row?.claudeSessionModel).toBe(AGENT_MODEL);
  });

  test('resumed eine Session mit passendem Modell', async () => {
    const cap = capturingRunner();
    const { db, service, projectId } = await setup(cap.runner);
    await db
      .update(projects)
      .set({ claudeSessionId: 'alte-session', claudeSessionModel: AGENT_MODEL })
      .where(eq(projects.id, projectId));
    await service.sendMessage(sendInput(projectId, 'Weiter'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.seen()).toBe('alte-session');
  });

  test('startet frisch, wenn die Session unter einem ANDEREN Modell erstellt wurde', async () => {
    const cap = capturingRunner();
    const { db, service, projectId } = await setup(cap.runner);
    await db
      .update(projects)
      .set({ claudeSessionId: 'opus-session', claudeSessionModel: 'claude-opus-4-8' })
      .where(eq(projects.id, projectId));
    await service.sendMessage(sendInput(projectId, 'Weiter'));
    await waitFor(() => !service.isTurnActive(projectId));
    // Modellwechsel auf bestehender Session hängt — darf NICHT resumed werden.
    expect(cap.seen()).toBeNull();
  });

  test('startet frisch, wenn kein Session-Modell hinterlegt ist (Altbestand)', async () => {
    const cap = capturingRunner();
    const { db, service, projectId } = await setup(cap.runner);
    await db
      .update(projects)
      .set({ claudeSessionId: 'legacy-session', claudeSessionModel: null })
      .where(eq(projects.id, projectId));
    await service.sendMessage(sendInput(projectId, 'Weiter'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.seen()).toBeNull();
  });
});

describe('Streaming-Rendering (Tool live, Text/Denk getrennt)', () => {
  test('Tool-Zeile ohne Detail zeigt nur den Namen (live via content_block_start)', async () => {
    const toolRunner: AgentRunner = {
      startTurn(): TurnHandle {
        const events = (async function* () {
          yield { type: 'tool-use', name: 'Read', detail: '' } as const;
          yield { type: 'tool-use', name: 'Edit', detail: 'index.html' } as const;
          yield { type: 'turn-completed', sessionId: 's' } as const;
        })();
        return { events, abort: () => {} };
      },
    };
    const { service, projectId } = await setup(toolRunner);
    await service.sendMessage(sendInput(projectId, 'Bau'));
    await waitFor(() => !service.isTurnActive(projectId));

    const tools = (await service.listMessages(projectId)).filter((m) => m.role === 'tool');
    expect(tools.map((m) => m.content)).toEqual(['Read', 'Edit: index.html']);
  });

  test('Text vor und nach einem Tool landet in getrennten Bubbles (block-stop)', async () => {
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        const events = (async function* () {
          yield { type: 'text-delta', text: 'Ich lese die Datei.' } as const;
          yield { type: 'block-stop' } as const;
          yield { type: 'tool-use', name: 'Read', detail: '' } as const;
          yield { type: 'text-delta', text: 'Erledigt.' } as const;
          yield { type: 'turn-completed', sessionId: 's' } as const;
        })();
        return { events, abort: () => {} };
      },
    };
    const { service, projectId } = await setup(runner);
    await service.sendMessage(sendInput(projectId, 'Los'));
    await waitFor(() => !service.isTurnActive(projectId));

    const assistants = (await service.listMessages(projectId)).filter(
      (m) => m.role === 'assistant',
    );
    expect(assistants.map((m) => m.content)).toEqual(['Ich lese die Datei.', 'Erledigt.']);
  });

  test('thinking-delta landet in einer eigenen "thinking"-Zeile', async () => {
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        const events = (async function* () {
          yield { type: 'thinking-delta', text: 'Ich überlege… ' } as const;
          yield { type: 'thinking-delta', text: 'fertig gedacht.' } as const;
          yield { type: 'text-delta', text: 'Antwort.' } as const;
          yield { type: 'turn-completed', sessionId: 's' } as const;
        })();
        return { events, abort: () => {} };
      },
    };
    const { service, projectId } = await setup(runner);
    await service.sendMessage(sendInput(projectId, 'Denk nach'));
    await waitFor(() => !service.isTurnActive(projectId));

    const messages = await service.listMessages(projectId);
    const thinking = messages.find((m) => m.role === 'thinking');
    expect(thinking?.content).toBe('Ich überlege… fertig gedacht.');
    expect(messages.find((m) => m.role === 'assistant')?.content).toBe('Antwort.');
  });
});

describe('sendMessage (R6)', () => {
  test('persistiert die Nutzer-Nachricht sofort und streamt die Antwort in die Historie', async () => {
    const { service, projectId } = await setup();
    await service.sendMessage(sendInput(projectId, 'Hallo Welt'));

    // Nutzer-Nachricht ist sofort da, noch bevor der Turn fertig ist.
    const immediate = await service.listMessages(projectId);
    expect(immediate.some((m) => m.role === 'user' && m.content === 'Hallo Welt')).toBe(true);

    await waitFor(async () => !service.isTurnActive(projectId));
    const messages = await service.listMessages(projectId);
    const roles = messages.map((m) => m.role);
    expect(roles[0]).toBe('user');
    expect(roles).toContain('tool');
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toContain('Echo: Hallo Welt');
  });

  test('Turn OHNE abschließenden Text (endet mit Tool) meldet trotzdem turnActive=false', async () => {
    // Regression: sonst bleibt der Client ewig auf "Agent arbeitet".
    const toolOnlyRunner: AgentRunner = {
      startTurn(): TurnHandle {
        const events = (async function* () {
          yield { type: 'tool-use', name: 'Edit', detail: '' } as const;
          yield { type: 'block-stop' } as const;
          yield { type: 'turn-completed', sessionId: 'sess-t' } as const;
        })();
        return { events, abort: () => {} };
      },
    };
    const { service, projectId } = await setup(toolOnlyRunner);
    const payloads: ChatEventPayload[] = [];
    const subscription = service.subscribe(projectId);
    const collector = (async () => {
      for await (const payload of subscription) payloads.push(payload);
    })();

    await service.sendMessage(sendInput(projectId, 'Ändere die Überschrift'));
    await waitFor(() => !service.isTurnActive(projectId));
    // Es muss ein finales Event mit turnActive=false angekommen sein.
    await waitFor(() => payloads.some((p) => !p.turnActive));
    await subscription.return?.(undefined);
    await collector;

    expect(service.isTurnActive(projectId)).toBe(false);
    expect(payloads[payloads.length - 1]?.turnActive).toBe(false);
  });

  test('veröffentlicht Events an Subscriber; letztes Event meldet turnActive=false', async () => {
    const { service, projectId } = await setup();
    const payloads: ChatEventPayload[] = [];
    const subscription = service.subscribe(projectId);
    const collector = (async () => {
      for await (const payload of subscription) {
        payloads.push(payload);
      }
    })();

    await service.sendMessage(sendInput(projectId, 'Streaming Test'));
    await waitFor(() => payloads.some((p) => !p.turnActive));
    await subscription.return?.(undefined);
    await collector;

    expect(payloads.some((p) => p.message.role === 'assistant')).toBe(true);
    const last = payloads[payloads.length - 1];
    expect(last?.turnActive).toBe(false);
  });

  test('Queue: zweiter Turn startet erst nach Abschluss des ersten', async () => {
    const log: string[] = [];
    const inner = new FakeAgentRunner(1);
    let counter = 0;
    const spyRunner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        counter += 1;
        const turnNo = counter;
        log.push(`start-${turnNo}`);
        const handle = inner.startTurn(options);
        const wrapped = (async function* () {
          for await (const event of handle.events) {
            if (event.type === 'turn-completed' || event.type === 'turn-aborted') {
              log.push(`end-${turnNo}`);
            }
            yield event;
          }
        })();
        return { events: wrapped, abort: handle.abort };
      },
    };

    const { service, projectId } = await setup(spyRunner);
    await service.sendMessage(sendInput(projectId, 'Eins'));
    await service.sendMessage(sendInput(projectId, 'Zwei'));

    await waitFor(async () => {
      const msgs = await service.listMessages(projectId);
      return (
        msgs.filter((m) => m.role === 'assistant').length === 2 && !service.isTurnActive(projectId)
      );
    });

    expect(log).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    const assistants = (await service.listMessages(projectId)).filter(
      (m) => m.role === 'assistant',
    );
    expect(assistants[0]?.content).toContain('Echo: Eins');
    expect(assistants[1]?.content).toContain('Echo: Zwei');
  });
});

describe('Mid-Turn-Steering (Phase C, interrupt)', () => {
  test('interrupt bricht den laufenden Turn ab und lässt die neue Nachricht laufen', async () => {
    const { service, projectId } = await setup();
    await service.sendMessage(sendInput(projectId, 'LANGSAM alte Aufgabe'));
    await waitFor(() => service.isTurnActive(projectId));
    await Bun.sleep(20);

    // Neue Anweisung mitten im Turn — mit interrupt.
    await service.sendMessage({ ...sendInput(projectId, 'Neue Aufgabe'), interrupt: true });

    await waitFor(async () => {
      const msgs = await service.listMessages(projectId);
      return (
        msgs.some((m) => m.role === 'assistant' && m.content.includes('Neue Aufgabe')) &&
        !service.isTurnActive(projectId)
      );
    });

    const messages = await service.listMessages(projectId);
    // Der alte Turn wurde abgebrochen, der neue kam durch.
    expect(messages.some((m) => m.role === 'system' && m.content.includes('abgebrochen'))).toBe(
      true,
    );
    expect(
      messages.some((m) => m.role === 'assistant' && m.content.includes('Echo: Neue Aufgabe')),
    ).toBe(true);
  });

  test('ohne interrupt bleibt es beim Queue-Verhalten (kein Abbruch)', async () => {
    const { service, projectId } = await setup();
    await service.sendMessage(sendInput(projectId, 'Eins'));
    await service.sendMessage(sendInput(projectId, 'Zwei'));
    await waitFor(async () => {
      const msgs = await service.listMessages(projectId);
      return (
        msgs.filter((m) => m.role === 'assistant').length === 2 && !service.isTurnActive(projectId)
      );
    });
    const messages = await service.listMessages(projectId);
    expect(messages.some((m) => m.role === 'system' && m.content.includes('abgebrochen'))).toBe(
      false,
    );
  });
});

describe('stopTurn (R6 Stop-Button)', () => {
  test('bricht den laufenden Turn ab und hinterlässt eine Abbruch-Zeile', async () => {
    const { service, projectId, turnEnds } = await setup();
    await service.sendMessage(sendInput(projectId, 'LANGSAM bitte'));
    await waitFor(() => service.isTurnActive(projectId));
    await Bun.sleep(30);

    service.stopTurn(projectId);
    await waitFor(() => !service.isTurnActive(projectId));

    const messages = await service.listMessages(projectId);
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('abgebrochen');
    expect(turnEnds).toEqual([]);
  });
});

describe('Fehlerbehandlung (R6)', () => {
  test('api-retry wird als eine Statuszeile sichtbar — ohne Spam bei Folge-Retries', async () => {
    const retryRunner: AgentRunner = {
      startTurn(): TurnHandle {
        const events = (async function* () {
          yield {
            type: 'api-retry',
            attempt: 1,
            maxRetries: 10,
            message: 'overloaded (Status 529)',
          } as const;
          yield {
            type: 'api-retry',
            attempt: 2,
            maxRetries: 10,
            message: 'overloaded (Status 529)',
          } as const;
          yield { type: 'text-delta', text: 'Doch noch da' } as const;
          yield { type: 'turn-completed', sessionId: 'sess-r' } as const;
        })();
        return { events, abort: () => {} };
      },
    };
    const { service, projectId } = await setup(retryRunner);
    await service.sendMessage(sendInput(projectId, 'Hallo'));
    await waitFor(() => !service.isTurnActive(projectId));

    const messages = await service.listMessages(projectId);
    const retryLines = messages.filter(
      (m) => m.role === 'system' && m.content.includes('Wiederholung'),
    );
    expect(retryLines).toHaveLength(1);
    expect(retryLines[0]?.content).toContain('overloaded');
    // Der Turn lief danach normal weiter.
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('Doch noch da'))).toBe(
      true,
    );
  });

  test('error-Events landen als error-Zeile in der Historie', async () => {
    const { service, projectId } = await setup();
    await service.sendMessage(sendInput(projectId, 'FEHLER provozieren'));
    await waitFor(() => !service.isTurnActive(projectId));

    const messages = await service.listMessages(projectId);
    expect(messages.some((m) => m.role === 'error')).toBe(true);
  });
});

describe('Hooks & Session (R8/R9)', () => {
  test('meldet Agent-Aktivität, ruft onTurnEnd und persistiert die Claude-Session', async () => {
    const { db, service, projectId, turnEnds, activity } = await setup();
    await service.sendMessage(sendInput(projectId, 'Hallo'));
    await waitFor(() => turnEnds.length === 1);

    expect(turnEnds).toEqual(['Hallo']);
    expect(activity.length).toBeGreaterThan(0);
    expect(activity[0]).toBe(projectId);

    const row = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
    expect(row?.claudeSessionId).toBe('fake-session');
  });
});
