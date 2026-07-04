import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { FakeAgentRunner } from '../../agent/fakeRunner';
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

async function setup(runner?: AgentRunner): Promise<TestSetup> {
  const db = createTestDb();
  const owner = await createUser(db, 'marco');
  const projectId = await createProjectRow(db, owner);
  const turnEnds: string[] = [];
  const activity: string[] = [];
  const service = new ChatService(db, runner ?? new FakeAgentRunner(1), {
    onAgentActivity: (id) => activity.push(id),
    onTurnEnd: async (_id, prompt) => {
      turnEnds.push(prompt);
    },
  });
  return { db, service, projectId, turnEnds, activity };
}

function sendInput(projectId: string, text: string) {
  return { projectId, workspaceDir: '/tmp/fake-workspace', resumeSessionId: null, text };
}

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
