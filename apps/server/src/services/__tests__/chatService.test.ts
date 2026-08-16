import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DEFAULT_AGENT_MODEL } from '../../agent/agentModel';
import { FakeAgentRunner } from '../../agent/fakeRunner';
import type { AgentEvent } from '../../agent/events';
import type { AgentRunner, TurnHandle, TurnOptions } from '../../agent/runner';
import type { Db } from '../../db/client';
import { projects, type UserRow } from '../../db/schema';
import {
  ChatService,
  MAX_MESSAGE_CHARS,
  type ChatEventPayload,
  type ChatServiceOptions,
} from '../chatService';
import { createTestDb, createUser } from './testUtils';

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  // 10 s statt 3 s: erfüllte Bedingungen kehren sofort zurück, die Frist
  // greift nur im Fehlerfall — 3 s rissen auf langsameren Maschinen
  // (Windows-Baseline) einen korrekten Interrupt-Test.
  timeoutMs = 10_000,
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
  /** Eigentümer des Testprojekts — sendMessage/stopTurn prüfen Ownership (M5). */
  owner: UserRow;
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
  agentColdStartTimeoutMs?: number,
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
    { agentIdleTimeoutMs, agentAbortGraceMs, agentFirstEventTimeoutMs, agentColdStartTimeoutMs },
  );
  return { db, owner, service, projectId, turnEnds, activity };
}

/** Wie `setup`, aber mit frei gesetzten ChatService-Optionen. */
async function setupChat(
  runner: AgentRunner,
  options: ChatServiceOptions = {},
): Promise<TestSetup> {
  const db = createTestDb();
  const owner = await createUser(db, 'marco');
  const projectId = await createProjectRow(db, owner);
  const turnEnds: string[] = [];
  const activity: string[] = [];
  const service = new ChatService(
    db,
    runner,
    {
      onAgentActivity: (id) => activity.push(id),
      onTurnEnd: async (_id, prompt) => {
        turnEnds.push(prompt);
      },
    },
    options,
  );
  return { db, owner, service, projectId, turnEnds, activity };
}

function sendInput(projectId: string, text: string) {
  return { projectId, workspaceDir: '/tmp/fake-workspace', text };
}

describe('Config-Warmup: erster Turn wird schnell, weil beim Öffnen vorgewärmt', () => {
  test('prewarm startet EINEN stillen Warmup-Turn (kein Chat-Eintrag)', async () => {
    const prompts: string[] = [];
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        prompts.push(options.prompt);
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text-delta', text: 'bereit' };
          yield { type: 'turn-completed', sessionId: 'w' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { owner, service, projectId } = await setup(runner);
    await service.prewarm(owner, projectId, '/tmp/ws');
    await service.prewarm(owner, projectId, '/tmp/ws'); // zweiter Aufruf = No-Op
    await waitFor(() => prompts.length >= 1);
    await Bun.sleep(50);
    expect(prompts.length).toBe(1); // nur EIN Warmup
    // Der Warmup erzeugt KEINE Chat-Nachrichten.
    expect((await service.listMessages(projectId)).length).toBe(0);
  });

  test('echter Turn wartet auf den laufenden Warmup (keine msb-Konkurrenz)', async () => {
    const order: string[] = [];
    let releaseWarmup: () => void = () => {};
    const runner: AgentRunner = {
      startTurn(_options: TurnOptions): TurnHandle {
        const isWarmup = order.length === 0;
        order.push(isWarmup ? 'warmup' : 'real');
        if (isWarmup) {
          const events = (async function* (): AsyncGenerator<AgentEvent> {
            await new Promise<void>((r) => {
              releaseWarmup = r;
            });
            yield { type: 'turn-completed', sessionId: 'w' };
          })();
          return { events, abort: () => {} };
        }
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text-delta', text: 'echt' };
          yield { type: 'turn-completed', sessionId: 'r' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { owner, service, projectId } = await setup(runner);
    await service.prewarm(owner, projectId, '/tmp/ws');
    await waitFor(() => order.length === 1);
    await service.sendMessage(owner, sendInput(projectId, 'echte Nachricht'));
    await Bun.sleep(60);
    // Der echte Turn darf NICHT laufen, solange der Warmup nicht fertig ist.
    expect(order).toEqual(['warmup']);
    releaseWarmup();
    await waitFor(() => !service.isTurnActive(projectId));
    expect(order).toEqual(['warmup', 'real']);
    expect((await service.listMessages(projectId)).some((m) => m.content === 'echt')).toBe(true);
  });

  test('prewarm überspringt, wenn schon eine Session existiert (Config bereits warm)', async () => {
    const prompts: string[] = [];
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        prompts.push(options.prompt);
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn-completed', sessionId: 'x' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { owner, db, service, projectId } = await setup(runner);
    await db
      .update(projects)
      .set({ claudeSessionId: 'vorhanden', claudeSessionModel: DEFAULT_AGENT_MODEL })
      .where(eq(projects.id, projectId));
    await service.prewarm(owner, projectId, '/tmp/ws');
    await Bun.sleep(50);
    expect(prompts.length).toBe(0);
  });
});

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
    const { owner, service, projectId } = await setup(stallingRunner, 40, 40);
    await service.sendMessage(owner, sendInput(projectId, 'Bau was Großes'));

    await waitFor(() => !service.isTurnActive(projectId), 3000);
    expect(aborted).toBe(true);
    const messages = await service.listMessages(projectId);
    const err = messages.find((m) => m.role === 'error');
    expect(err).toBeDefined();
    expect(err?.content.toLowerCase()).toContain('nicht reagiert');
  });

  test('liefert der abgebrochene Prozess noch eine Fehlermeldung, hängt sie an', async () => {
    // Nach dem Abort liefert der Runner noch einen späten Fehler nach (z. B. der
    // Daemon-Runner beim ACK-Timeout/Reconnect) — der muss angehängt werden.
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
    const { owner, service, projectId } = await setup(runner, 40, 200);
    await service.sendMessage(owner, sendInput(projectId, 'x'));
    await waitFor(() => !service.isTurnActive(projectId), 3000);
    const err = (await service.listMessages(projectId)).find((m) => m.role === 'error');
    expect(err?.content).toContain('ECONNREFUSED');
  });
});

/**
 * M1 aus dem Zustandsmaschinen-Audit, Service-Hälfte: Stoppt der Nutzer,
 * während der Runner-Stream stumm bleibt (Daemon im Verbindungs-Limbo — sein
 * abort liefert dann kein turn-aborted), schrieb der Watchdog KEINE Zeile:
 * die Bedingung für die error-Zeile war auf Versuch 1 beidseitig false, und
 * die Retry-Schleife brach wegen benutzerAbbruch ab, bevor der letzte Versuch
 * sie hätte schreiben können. Folgen: kein finales turnActive:false („Agent
 * arbeitet" für immer) und — schlimmer — die letzte DB-Zeile blieb die
 * User-Nachricht, sodass resumeUnansweredTurn beim nächsten Öffnen GENAU den
 * gestoppten Prompt erneut ausführte. Der Backstop hier gilt für JEDEN Runner,
 * unabhängig vom DaemonRunner-Fix derselben Konstellation.
 */
describe('Stop bei nicht erreichbarem Daemon (M1): Terminal-Zeile trotz stummem Runner', () => {
  test('Nutzer-Stop ohne Runner-Reaktion schreibt „Turn abgebrochen" und beendet turnActive', async () => {
    let starts = 0;
    // Vertragsverletzender Runner als Robustheits-Seam: events lösen nie auf,
    // abort() emittiert NICHTS (Daemon nie verbunden, pre-M1a-Verhalten).
    const stummerRunner: AgentRunner = {
      startTurn(): TurnHandle {
        starts += 1;
        const events: AsyncIterable<never> = {
          [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
        };
        return { events, abort: () => {} };
      },
    };
    const { owner, service, projectId } = await setupChat(stummerRunner, {
      agentFirstEventTimeoutMs: 40,
      agentColdStartTimeoutMs: 60,
      agentAbortGraceMs: 20,
    });

    const payloads: ChatEventPayload[] = [];
    const subscription = service.subscribe(projectId);
    const collector = (async () => {
      for await (const payload of subscription) payloads.push(payload);
    })();

    await service.sendMessage(owner, sendInput(projectId, 'gestoppter Prompt'));
    await waitFor(() => starts === 1);
    await service.stopTurn(owner, projectId);
    await waitFor(() => !service.isTurnActive(projectId), 3000);

    // DER Kern des Befunds: es MUSS eine Terminal-Zeile geben …
    const messages = await service.listMessages(projectId);
    const letzte = messages[messages.length - 1];
    expect(letzte?.role).toBe('system');
    expect(letzte?.content).toContain('abgebrochen');
    // … kein error (Nutzer-Stop ist kein Fehler), kein Retry:
    expect(messages.some((m) => m.role === 'error')).toBe(false);
    expect(messages.some((m) => m.content.includes('zweiter Versuch'))).toBe(false);

    // Das finale turnActive:false MUSS publiziert worden sein.
    await waitFor(() => payloads.some((p) => !p.turnActive));
    await subscription.return?.(undefined);
    await collector;
    expect(payloads[payloads.length - 1]?.turnActive).toBe(false);

    // Und der gestoppte Prompt läuft beim nächsten Öffnen NICHT erneut.
    expect(await service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace')).toBe(false);
    expect(starts).toBe(1);
  });
});

describe('Kaltstart-Timeout: der ERSTE Turn (frische VM) bekommt mehr Zeit', () => {
  test('erstes Event kommt spät (nach dem kurzen Timeout), Turn läuft trotzdem — weil Kaltstart', async () => {
    // Frisches Projekt (keine Session) => Kaltstart. claudes First-Run in der frisch
    // geforkten VM braucht >kurzer-Timeout; das darf NICHT fälschlich abbrechen.
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          await new Promise((r) => setTimeout(r, 200)); // "langsamer" erster Start
          yield { type: 'text-delta', text: 'Endlich da.' };
          yield { type: 'turn-completed', sessionId: 's1' };
        })();
        return { events, abort: () => {} };
      },
    };
    // firstEvent kurz (50ms) würde abbrechen; coldStart großzügig (2s) rettet den ersten Turn.
    const { owner, service, projectId } = await setup(runner, 10_000, 40, 50, 2_000);
    await service.sendMessage(owner, sendInput(projectId, 'Erster Prompt'));
    await waitFor(() => !service.isTurnActive(projectId), 5000);
    const messages = await service.listMessages(projectId);
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'Endlich da.')).toBe(true);
    expect(messages.some((m) => m.role === 'error')).toBe(false);
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
    const { owner, service, projectId } = await setup(runner, 10_000, 40, 50, 50);
    const t0 = Date.now();
    await service.sendMessage(owner, sendInput(projectId, 'x'));
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
    const { owner, service, projectId } = await setup(runner, 10_000, 40, 50, 50);
    await service.sendMessage(owner, sendInput(projectId, 'x'));
    await waitFor(() => !service.isTurnActive(projectId), 5000);
    const messages = await service.listMessages(projectId);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('sofort da — und fertig');
    expect(messages.some((m) => m.role === 'error')).toBe(false);
  });
});

describe('Kontext-Recovery: frischer Start bekommt die Chat-Historie mitgegeben', () => {
  function capturingRunner(): { runner: AgentRunner; prompt: () => string } {
    let seen = '';
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        seen = options.prompt;
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn-completed', sessionId: 's' };
        })();
        return { events, abort: () => {} };
      },
    };
    return { runner, prompt: () => seen };
  }

  test('ohne Resume (keine Session) wird der bisherige Verlauf in den Prompt gepackt', async () => {
    const cap = capturingRunner();
    const { owner, service, projectId } = await setup(cap.runner);
    await service.postMessage(projectId, 'user', 'Baue ein Dobble-Spiel');
    await service.postMessage(projectId, 'assistant', 'Grundgeruest steht.');
    await service.sendMessage(owner, sendInput(projectId, 'mach die Karten groesser'));
    await waitFor(() => !service.isTurnActive(projectId));
    const p = cap.prompt();
    expect(p).toContain('Baue ein Dobble-Spiel'); // Verlauf drin
    expect(p).toContain('Grundgeruest steht'); // Assistant-Antwort drin
    expect(p).toContain('mach die Karten groesser'); // die eigentliche neue Aufgabe
  });

  test('mit gültiger Session (Resume) wird KEINE Historie eingebettet — Resume trägt sie', async () => {
    const cap = capturingRunner();
    const { owner, db, service, projectId } = await setup(cap.runner);
    await db
      .update(projects)
      .set({ claudeSessionId: 's1', claudeSessionModel: DEFAULT_AGENT_MODEL })
      .where(eq(projects.id, projectId));
    await service.postMessage(projectId, 'user', 'alter turn');
    await service.sendMessage(owner, sendInput(projectId, 'neuer prompt'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.prompt()).toBe('neuer prompt');
  });

  test('erster Turn ohne jede Historie bekommt nur den reinen Prompt', async () => {
    const cap = capturingRunner();
    const { owner, service, projectId } = await setup(cap.runner);
    await service.sendMessage(owner, sendInput(projectId, 'allererster prompt'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.prompt()).toBe('allererster prompt');
  });

  test('viele tool-Zeilen verdrängen die Konversation NICHT aus dem Fenster (#13)', async () => {
    // Ein tool-lastiger Turn schreibt dutzende tool/system/error-Zeilen. Vorher
    // holte withHistoryContext die letzten 200 ROHzeilen und filterte danach —
    // die waren dann fast nur tool-Zeilen, und die Konversation fiel aus dem
    // Fenster. Der Agent startete gedächtnislos.
    const cap = capturingRunner();
    const { owner, service, projectId } = await setup(cap.runner);

    await service.postMessage(projectId, 'user', 'Baue mir einen Shop');
    await service.postMessage(projectId, 'assistant', 'Warenkorb ist fertig.');
    // 250 tool-Zeilen dazwischen — mehr als jedes plausible Rohfenster.
    for (let i = 0; i < 250; i += 1) {
      await service.postMessage(projectId, 'tool', `edit datei-${i}.ts`);
    }

    await service.sendMessage(owner, sendInput(projectId, 'weiter'));
    await waitFor(() => !service.isTurnActive(projectId));

    const p = cap.prompt();
    // Die Konversation muss trotz der 250 tool-Zeilen im Prompt landen.
    expect(p).toContain('Baue mir einen Shop');
    expect(p).toContain('Warenkorb ist fertig');
    expect(p).toContain('weiter');
  });
});

describe('Retry ohne Session-Resume: hängender/korrupter Resume heilt sich selbst', () => {
  test('Versuch 1 resumed (hängt), Versuch 2 startet FRISCH und liefert', async () => {
    // Reproduziert den Live-Bug: ein per neuem Prompt unterbrochener Turn lässt
    // die claude-Session korrupt zurück; --resume darauf hängt bei JEDEM Prompt.
    let calls = 0;
    const seenResume: (string | null)[] = [];
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        calls += 1;
        seenResume.push(options.resumeSessionId);
        if (options.resumeSessionId != null) {
          // Resume auf die korrupte Session hängt (kein Event).
          const events: AsyncIterable<never> = {
            [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
          };
          return { events, abort: () => {} };
        }
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text-delta', text: 'frisch ok' };
          yield { type: 'turn-completed', sessionId: 'neu' };
        })();
        return { events, abort: () => {} };
      },
    };
    // firstEvent + coldStart klein, damit der hängende Versuch schnell abbricht.
    const { owner, db, service, projectId } = await setup(runner, 10_000, 40, 40, 40);
    await db
      .update(projects)
      .set({ claudeSessionId: 'korrupt', claudeSessionModel: DEFAULT_AGENT_MODEL })
      .where(eq(projects.id, projectId));
    await service.sendMessage(owner, sendInput(projectId, 'weiter'));
    await waitFor(() => !service.isTurnActive(projectId), 3000);

    expect(calls).toBe(2);
    // Versuch 1 mit Resume, Versuch 2 OHNE — das ist der Selbstheil-Kern.
    expect(seenResume).toEqual(['korrupt', null]);
    const msgs = await service.listMessages(projectId);
    expect(msgs.some((m) => m.role === 'assistant' && m.content === 'frisch ok')).toBe(true);
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
  });
});

describe('Auto-Retry: stummer Agent-Start wird einmal neu versucht (Transport-Flakiness)', () => {
  test('Versuch 1 stirbt ohne Events, Versuch 2 liefert — Turn wird trotzdem fertig', async () => {
    let calls = 0;
    const flakyRunner: AgentRunner = {
      startTurn(): TurnHandle {
        calls += 1;
        if (calls === 1) {
          // Transport-Flake: der Turn stirbt sofort, ohne je ein Event zu liefern
          // (z. B. veraltete Daemon-Verbindung → turn-aborted ohne Quittung).
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
    const { owner, service, projectId } = await setup(flakyRunner, 500, 40);
    await service.sendMessage(owner, sendInput(projectId, 'Bau'));
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
    const { owner, service, projectId } = await setup(flakyRunner, 40, 40);
    await service.sendMessage(owner, sendInput(projectId, 'x'));
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
    const { owner, service, projectId } = await setup(runner, 500, 40);
    await service.sendMessage(owner, sendInput(projectId, 'x'));
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
    const { owner, db, service, projectId } = await setup(capturingRunner().runner);
    await service.sendMessage(owner, sendInput(projectId, 'Bau'));
    await waitFor(() => !service.isTurnActive(projectId));
    const row = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
    expect(row?.claudeSessionId).toBe('neue-session');
    expect(row?.claudeSessionModel).toBe(DEFAULT_AGENT_MODEL);
  });

  test('resumed eine Session mit passendem Modell', async () => {
    const cap = capturingRunner();
    const { owner, db, service, projectId } = await setup(cap.runner);
    await db
      .update(projects)
      .set({ claudeSessionId: 'alte-session', claudeSessionModel: DEFAULT_AGENT_MODEL })
      .where(eq(projects.id, projectId));
    await service.sendMessage(owner, sendInput(projectId, 'Weiter'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.seen()).toBe('alte-session');
  });

  test('startet frisch, wenn die Session unter einem ANDEREN Modell erstellt wurde', async () => {
    const cap = capturingRunner();
    const { owner, db, service, projectId } = await setup(cap.runner);
    await db
      .update(projects)
      .set({ claudeSessionId: 'opus-session', claudeSessionModel: 'claude-opus-4-8' })
      .where(eq(projects.id, projectId));
    await service.sendMessage(owner, sendInput(projectId, 'Weiter'));
    await waitFor(() => !service.isTurnActive(projectId));
    // Modellwechsel auf bestehender Session hängt — darf NICHT resumed werden.
    expect(cap.seen()).toBeNull();
  });

  test('startet frisch, wenn kein Session-Modell hinterlegt ist (Altbestand)', async () => {
    const cap = capturingRunner();
    const { owner, db, service, projectId } = await setup(cap.runner);
    await db
      .update(projects)
      .set({ claudeSessionId: 'legacy-session', claudeSessionModel: null })
      .where(eq(projects.id, projectId));
    await service.sendMessage(owner, sendInput(projectId, 'Weiter'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.seen()).toBeNull();
  });
});

describe('Modellwahl pro Projekt (Dropdown im Chat)', () => {
  /** Runner, der das übergebene Modell + resumeSessionId festhält. */
  function modelCapturingRunner(): {
    runner: AgentRunner;
    model: () => string | null;
    resume: () => string | null;
  } {
    let model: string | null = null;
    let resume: string | null = null;
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        model = options.model;
        resume = options.resumeSessionId;
        const events = (async function* () {
          yield { type: 'turn-completed', sessionId: 'sess-1' } as const;
        })();
        return { events, abort: () => {} };
      },
    };
    return { runner, model: () => model, resume: () => resume };
  }

  test('der Turn läuft mit dem Projekt-Modell (nicht mit einem globalen Default)', async () => {
    const cap = modelCapturingRunner();
    const { owner, db, service, projectId } = await setup(cap.runner);
    await db
      .update(projects)
      .set({ agentModel: 'qwen3.6-coder' })
      .where(eq(projects.id, projectId));
    await service.sendMessage(owner, sendInput(projectId, 'Bau ein Board'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.model()).toBe('qwen3.6-coder');
  });

  test('ohne explizite Wahl läuft der Turn mit dem Default (Sonnet 5)', async () => {
    const cap = modelCapturingRunner();
    const { owner, service, projectId } = await setup(cap.runner);
    await service.sendMessage(owner, sendInput(projectId, 'Bau'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.model()).toBe(DEFAULT_AGENT_MODEL);
  });

  test('die Session wird mit dem PROJEKT-Modell gespeichert', async () => {
    const cap = modelCapturingRunner();
    const { owner, db, service, projectId } = await setup(cap.runner);
    await db
      .update(projects)
      .set({ agentModel: 'claude-haiku-4-5' })
      .where(eq(projects.id, projectId));
    await service.sendMessage(owner, sendInput(projectId, 'Bau'));
    await waitFor(() => !service.isTurnActive(projectId));
    const row = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
    expect(row?.claudeSessionModel).toBe('claude-haiku-4-5');
  });

  test('prewarm überspringt langsame (lokale) Modelle — der Warmup würde den Daemon blockieren', async () => {
    const prompts: string[] = [];
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        prompts.push(options.prompt);
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn-completed', sessionId: 'w' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { owner, db, service, projectId } = await setup(runner);
    await db
      .update(projects)
      .set({ agentModel: 'qwen3.6-coder' })
      .where(eq(projects.id, projectId));
    await service.prewarm(owner, projectId, '/tmp/ws');
    await Bun.sleep(30);
    expect(prompts).toHaveLength(0);
  });

  test('Modellwechsel im Projekt startet die Session frisch, gleiches Modell resumed', async () => {
    const cap = modelCapturingRunner();
    const { owner, db, service, projectId } = await setup(cap.runner);
    // Session wurde unter qwen erstellt, Projekt steht jetzt auf Opus → kein Resume.
    await db
      .update(projects)
      .set({
        agentModel: 'claude-opus-4-8',
        claudeSessionId: 'qwen-session',
        claudeSessionModel: 'qwen3.6-coder',
      })
      .where(eq(projects.id, projectId));
    await service.sendMessage(owner, sendInput(projectId, 'Weiter'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.resume()).toBeNull();

    // Jetzt passt das Session-Modell zum Projekt-Modell → Resume.
    await db
      .update(projects)
      .set({ claudeSessionId: 'opus-session', claudeSessionModel: 'claude-opus-4-8' })
      .where(eq(projects.id, projectId));
    await service.sendMessage(owner, sendInput(projectId, 'Und weiter'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.resume()).toBe('opus-session');
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
    const { owner, service, projectId } = await setup(toolRunner);
    await service.sendMessage(owner, sendInput(projectId, 'Bau'));
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
    const { owner, service, projectId } = await setup(runner);
    await service.sendMessage(owner, sendInput(projectId, 'Los'));
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
    const { owner, service, projectId } = await setup(runner);
    await service.sendMessage(owner, sendInput(projectId, 'Denk nach'));
    await waitFor(() => !service.isTurnActive(projectId));

    const messages = await service.listMessages(projectId);
    const thinking = messages.find((m) => m.role === 'thinking');
    expect(thinking?.content).toBe('Ich überlege… fertig gedacht.');
    expect(messages.find((m) => m.role === 'assistant')?.content).toBe('Antwort.');
  });
});

describe('sendMessage (R6)', () => {
  test('persistiert die Nutzer-Nachricht sofort und streamt die Antwort in die Historie', async () => {
    const { owner, service, projectId } = await setup();
    await service.sendMessage(owner, sendInput(projectId, 'Hallo Welt'));

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
    const { owner, service, projectId } = await setup(toolOnlyRunner);
    const payloads: ChatEventPayload[] = [];
    const subscription = service.subscribe(projectId);
    const collector = (async () => {
      for await (const payload of subscription) payloads.push(payload);
    })();

    await service.sendMessage(owner, sendInput(projectId, 'Ändere die Überschrift'));
    await waitFor(() => !service.isTurnActive(projectId));
    // Es muss ein finales Event mit turnActive=false angekommen sein.
    await waitFor(() => payloads.some((p) => !p.turnActive));
    await subscription.return?.(undefined);
    await collector;

    expect(service.isTurnActive(projectId)).toBe(false);
    expect(payloads[payloads.length - 1]?.turnActive).toBe(false);
  });

  test('veröffentlicht Events an Subscriber; letztes Event meldet turnActive=false', async () => {
    const { owner, service, projectId } = await setup();
    const payloads: ChatEventPayload[] = [];
    const subscription = service.subscribe(projectId);
    const collector = (async () => {
      for await (const payload of subscription) {
        payloads.push(payload);
      }
    })();

    await service.sendMessage(owner, sendInput(projectId, 'Streaming Test'));
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

    const { owner, service, projectId } = await setup(spyRunner);
    await service.sendMessage(owner, sendInput(projectId, 'Eins'));
    await service.sendMessage(owner, sendInput(projectId, 'Zwei'));

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
    expect(assistants[0]?.content).toContain('Eins');
    expect(assistants[1]?.content).toContain('Zwei');
  });
});

describe('Mid-Turn-Steering (Phase C, interrupt)', () => {
  test('interrupt bricht den laufenden Turn ab und lässt die neue Nachricht laufen', async () => {
    const { owner, service, projectId } = await setup();
    await service.sendMessage(owner, sendInput(projectId, 'LANGSAM alte Aufgabe'));
    await waitFor(() => service.isTurnActive(projectId));
    await Bun.sleep(20);

    // Neue Anweisung mitten im Turn — mit interrupt.
    await service.sendMessage(owner, { ...sendInput(projectId, 'Neue Aufgabe'), interrupt: true });

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
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('Neue Aufgabe'))).toBe(
      true,
      // 20 s Testfrist: der LANGSAM-Fake-Turn + Abbruch + neuer Turn liegen
      // auf langsameren Maschinen über Buns 5-s-Default (Windows-Baseline).
    );
  }, 20_000);

  test('ohne interrupt bleibt es beim Queue-Verhalten (kein Abbruch)', async () => {
    const { owner, service, projectId } = await setup();
    await service.sendMessage(owner, sendInput(projectId, 'Eins'));
    await service.sendMessage(owner, sendInput(projectId, 'Zwei'));
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
    const { owner, service, projectId, turnEnds } = await setup();
    await service.sendMessage(owner, sendInput(projectId, 'LANGSAM bitte'));
    await waitFor(() => service.isTurnActive(projectId));
    await Bun.sleep(30);

    await service.stopTurn(owner, projectId);
    await waitFor(() => !service.isTurnActive(projectId));

    const messages = await service.listMessages(projectId);
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('abgebrochen');
    expect(turnEnds).toEqual([]);
  });

  test('Race: stopTurn unmittelbar nach sendMessage bricht trotzdem ab', async () => {
    // sendMessage() reiht den Turn nur ein und stößt pump() fire-and-forget an —
    // der Agent-Runner-Handle wird erst etwas später (nach dem ersten await in
    // runAttempt) in state.currentHandle gesetzt. Klickt der Nutzer "Stopp"
    // extrem schnell, darf der Abbruch nicht stillschweigend wirkungslos sein,
    // egal ob das Handle schon steht oder nicht. (Das Startfenster OHNE Handle
    // erzwingt Test (3) im Gegenwartsmodell-Block deterministisch über den
    // Config-Warmup.)
    const { owner, service, projectId, turnEnds } = await setup();
    await service.sendMessage(owner, sendInput(projectId, 'LANGSAM bitte'));
    await service.stopTurn(owner, projectId); // unmittelbar danach — reproduziert die Race.

    await waitFor(() => !service.isTurnActive(projectId), 15_000);

    const messages = await service.listMessages(projectId);
    const system = messages.find((m) => m.role === 'system');
    expect(system?.content).toContain('abgebrochen');
    expect(turnEnds).toEqual([]);
  });
});

/**
 * M5: Die Ownership-Regel hängt am SERVICE, nicht (nur) am Resolver. Diese
 * Tests rufen den ChatService DIREKT auf — ohne GraphQL-Schicht — und belegen,
 * dass die Regel auch dann greift: ein künftiger Transport oder ein Skript
 * kann sie nicht versehentlich umgehen. Bewusst strikt Owner-only OHNE
 * Admin-Ausnahme (R10: fremde Projekte sind les- und kopierbar, Chatten,
 * Stoppen und Modellwahl bleiben dem Eigentümer vorbehalten).
 */
describe('Ownership am Service (M5): sendMessage/stopTurn prüfen selbst', () => {
  test('sendMessage eines fremden Nutzers: DomainError, keine Zeile, kein Turn', async () => {
    const ctrl = steuerbarerRunner();
    const { db, service, projectId } = await setupChat(ctrl.runner);
    const fremd = await createUser(db, 'eve');

    await expect(
      service.sendMessage(fremd, sendInput(projectId, 'fremder Prompt')),
    ).rejects.toThrow(/Eigentümer/);

    expect(ctrl.starts).toHaveLength(0);
    expect(await service.listMessages(projectId)).toHaveLength(0);
    expect(service.isTurnActive(projectId)).toBe(false);
  });

  test('stopTurn eines fremden Nutzers: DomainError, der laufende Turn läuft weiter', async () => {
    const ctrl = steuerbarerRunner();
    const { db, owner, service, projectId, turnEnds } = await setupChat(ctrl.runner);
    const fremd = await createUser(db, 'eve');
    await service.sendMessage(owner, sendInput(projectId, 'lange Aufgabe'));
    await waitFor(() => ctrl.starts.length === 1);

    await expect(service.stopTurn(fremd, projectId)).rejects.toThrow(/Eigentümer/);

    // Der Turn des Owners bleibt unberührt und endet regulär.
    expect(ctrl.laeufe[0]?.abgebrochen()).toBe(false);
    expect(service.isTurnActive(projectId)).toBe(true);
    ctrl.laeufe[0]?.fertigstellen();
    await waitFor(() => !service.isTurnActive(projectId));
    expect(turnEnds).toEqual(['lange Aufgabe']);
  });

  test('auch ein Admin darf im fremden Projekt weder chatten noch stoppen (R10)', async () => {
    // Bewusst strenger als deleteProject/renameProject (dort Owner ODER
    // Admin): die Chat-Fläche bleibt Owner-only. `setup` legt marco als
    // ERSTEN User an — er ist damit der Bootstrap-Admin.
    const ctrl = steuerbarerRunner();
    const { db, owner: admin, service } = await setupChat(ctrl.runner);
    expect(admin.role).toBe('admin');
    const olivia = await createUser(db, 'olivia');
    const fremdesProjekt = await createProjectRow(db, olivia, 'projekt-olivia');

    await expect(service.sendMessage(admin, sendInput(fremdesProjekt, 'hallo'))).rejects.toThrow(
      /Eigentümer/,
    );
    await expect(service.stopTurn(admin, fremdesProjekt)).rejects.toThrow(/Eigentümer/);
    expect(ctrl.starts).toHaveLength(0);
  });

  test('unbekanntes Projekt: DomainError — und kein liegenbleibender leerer State', async () => {
    const { owner, service } = await setup();

    await expect(service.sendMessage(owner, sendInput('gibt-es-nicht', 'x'))).rejects.toThrow(
      /nicht gefunden/,
    );
    await expect(service.stopTurn(owner, 'gibt-es-nicht')).rejects.toThrow(/nicht gefunden/);

    // Die Prüfung läuft VOR dem lazy state() — sonst entstünde pro Tippfehler
    // ein leerer Eintrag für die Prozesslebensdauer (Leck-Klasse wie in H11).
    expect(service.trackedProjects()).toBe(0);
  });
});

/**
 * M5 auch für die turn-startenden Nebenpfade: resumeUnansweredTurn reiht einen
 * VOLLEN Agent-Turn ein (inkl. Auto-Commit am Ende), prewarm startet einen
 * Wegwerf-Turn — beide hingen bisher allein am ownerId-Branch des
 * enterProject-Resolvers, also an der Disziplin des Transports.
 *
 * WICHTIG, anderer Vertrag als sendMessage/stopTurn: Für Besucher ist das
 * KEINE Authz-Ablehnung, sondern FEATURE-GATING — sie bekommen schlicht kein
 * Resume und keinen Warmup. Ein Wurf würde enterProject für Nur-Lese-Besucher
 * (R10) kaputtmachen. Die Methoden kehren bei fremdem Projekt deshalb STILL
 * zurück; diese Tests rufen den Service DIREKT auf und belegen beides:
 * kein Turn UND kein Wurf.
 */
describe('Feature-Gating am Service (M5): resumeUnansweredTurn/prewarm sind Owner-only', () => {
  test('resumeUnansweredTurn eines fremden Nutzers: still false — kein Wurf, kein Turn, keine Zeilen', async () => {
    const ctrl = steuerbarerRunner();
    const { service, projectId, db, turnEnds } = await setupChat(ctrl.runner);
    const fremd = await createUser(db, 'eve');
    // Die letzte Zeile IST eine unbeantwortete User-Zeile — der einzige Grund,
    // warum kein Turn startet, ist das Gating.
    await service.postMessage(projectId, 'user', 'Bau ein Memory-Spiel');

    await expect(
      service.resumeUnansweredTurn(fremd, projectId, '/tmp/fake-workspace'),
    ).resolves.toBe(false);

    await Bun.sleep(30);
    expect(ctrl.starts).toHaveLength(0);
    expect(service.isTurnActive(projectId)).toBe(false);
    expect(turnEnds).toEqual([]); // kein Auto-Commit-Hook
    // Keine neuen Zeilen — nur die eine User-Zeile von oben.
    expect(await service.listMessages(projectId)).toHaveLength(1);
    // Das Gating läuft VOR dem lazy state() (Leck-Klasse wie in H11).
    expect(service.trackedProjects()).toBe(0);
  });

  test('prewarm eines fremden Nutzers: stille Rückkehr — kein Wurf, kein Warmup-Turn', async () => {
    const ctrl = steuerbarerRunner();
    const { service, projectId, db } = await setupChat(ctrl.runner);
    const fremd = await createUser(db, 'eve');

    await expect(service.prewarm(fremd, projectId, '/tmp/ws')).resolves.toBeUndefined();

    await Bun.sleep(30);
    expect(ctrl.starts).toHaveLength(0);
    expect(service.trackedProjects()).toBe(0);
  });

  test('auch ein Admin bekommt im fremden Projekt weder Resume noch Warmup (R10)', async () => {
    // Konsistent mit sendMessage/stopTurn: strikt Owner-only, KEINE
    // Admin-Ausnahme. `setup` legt marco als ERSTEN User an — Bootstrap-Admin.
    const ctrl = steuerbarerRunner();
    const { owner: admin, service, db } = await setupChat(ctrl.runner);
    expect(admin.role).toBe('admin');
    const olivia = await createUser(db, 'olivia');
    const fremdesProjekt = await createProjectRow(db, olivia, 'projekt-olivia');
    await service.postMessage(fremdesProjekt, 'user', 'unbeantwortet');

    await expect(
      service.resumeUnansweredTurn(admin, fremdesProjekt, '/tmp/fake-workspace'),
    ).resolves.toBe(false);
    await expect(service.prewarm(admin, fremdesProjekt, '/tmp/ws')).resolves.toBeUndefined();

    await Bun.sleep(30);
    expect(ctrl.starts).toHaveLength(0);
  });

  test('unbekanntes Projekt: ebenfalls stille Rückkehr (anders als sendMessage/stopTurn)', async () => {
    // Bewusst KEIN „nicht gefunden"-Wurf wie bei sendMessage/stopTurn: die
    // beiden Methoden sind Beschleuniger/Komfort, kein Nutzerbefehl — es gibt
    // niemanden, dem der Fehler etwas sagen würde (enterProject wirft für
    // unbekannte Projekte längst selbst). Einheitliche Gating-Semantik:
    // „nichts Eigenes da" heißt still nichts tun.
    const ctrl = steuerbarerRunner();
    const { owner, service } = await setupChat(ctrl.runner);

    await expect(
      service.resumeUnansweredTurn(owner, 'gibt-es-nicht', '/tmp/fake-workspace'),
    ).resolves.toBe(false);
    await expect(service.prewarm(owner, 'gibt-es-nicht', '/tmp/ws')).resolves.toBeUndefined();

    await Bun.sleep(30);
    expect(ctrl.starts).toHaveLength(0);
    expect(service.trackedProjects()).toBe(0);
  });
});

/**
 * Ein Runner, der einen Abbruch ernst nimmt: nach abort() liefert er NUR
 * `turn-aborted` und sonst nichts. Genau daran hing der Fehler — ein solcher
 * Turn hat kein „sinnvolles" Event gesehen und galt deshalb als msb-Flake.
 */
function abbrechbarerRunner(starts: string[], verzoegerungMs = 20): AgentRunner {
  return {
    startTurn(options: TurnOptions): TurnHandle {
      starts.push(options.prompt);
      let abbrechen: () => void = () => {};
      const abgebrochen = new Promise<void>((resolve) => {
        abbrechen = resolve;
      });
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        const ausgang = await Promise.race([
          abgebrochen.then(() => 'abbruch' as const),
          Bun.sleep(verzoegerungMs).then(() => 'weiter' as const),
        ]);
        if (ausgang === 'abbruch') {
          yield { type: 'turn-aborted' };
          return;
        }
        yield { type: 'text-delta', text: 'fertig' };
        yield { type: 'turn-completed', sessionId: 'sess-1' };
      })();
      return { events, abort: () => abbrechen() };
    },
  };
}

describe('Abbruch ist kein Flake — kein stiller zweiter Durchlauf', () => {
  test('Stop vor dem ersten Event lässt den Turn NICHT neu laufen', async () => {
    // Der Nutzer drückt Stop direkt nach dem Senden. Der Turn liefert nur
    // `turn-aborted`; das zählt nicht als sinnvolles Lebenszeichen, also hielt
    // runTurn den Versuch für einen msb-Flake und schickte denselben Prompt ein
    // zweites Mal los — diesmal ohne Abbruchwunsch. Der Agent führte den Turn
    // also trotz Stop vollständig aus, schrieb Dateien und committete sie.
    const starts: string[] = [];
    const { owner, service, projectId, turnEnds } = await setup(abbrechbarerRunner(starts, 10_000));

    await service.sendMessage(owner, sendInput(projectId, 'bitte nicht ausführen'));
    await waitFor(() => starts.length === 1);
    await service.stopTurn(owner, projectId);

    // Ohne Fix startet genau hier der zweite Versuch — mit demselben Prompt,
    // aber ohne Abbruchwunsch, und läuft dann vollständig durch.
    await Bun.sleep(200);
    expect(starts).toEqual(['bitte nicht ausführen']);

    await waitFor(() => !service.isTurnActive(projectId), 15_000);
    expect(turnEnds).toEqual([]);
    // Der Abbruch bleibt sichtbar — sonst stünde der Nutzer ohne Rückmeldung da.
    const messages = await service.listMessages(projectId);
    expect(messages.find((m) => m.role === 'system')?.content).toContain('abgebrochen');
  });
});

/**
 * Runner, bei dem jeder gestartete Turn einzeln steuerbar ist: `fertigstellen`
 * lässt ihn normal enden (Echo + turn-completed), ein `abort()` seines Handles
 * liefert NUR `turn-aborted` — wie ein Abbruch, der ernst genommen wird.
 */
function steuerbarerRunner(): {
  runner: AgentRunner;
  starts: string[];
  laeufe: { fertigstellen: () => void; abgebrochen: () => boolean }[];
} {
  const starts: string[] = [];
  const laeufe: { fertigstellen: () => void; abgebrochen: () => boolean }[] = [];
  const runner: AgentRunner = {
    startTurn(options: TurnOptions): TurnHandle {
      starts.push(options.prompt);
      let fertig: () => void = () => {};
      let abbruch: () => void = () => {};
      let abgebrochen = false;
      const fertigDa = new Promise<void>((resolve) => {
        fertig = resolve;
      });
      const abbruchDa = new Promise<void>((resolve) => {
        abbruch = resolve;
      });
      laeufe.push({ fertigstellen: () => fertig(), abgebrochen: () => abgebrochen });
      const nummer = laeufe.length;
      const prompt = options.prompt;
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        const ausgang = await Promise.race([
          abbruchDa.then(() => 'abbruch' as const),
          fertigDa.then(() => 'fertig' as const),
        ]);
        if (ausgang === 'abbruch') {
          yield { type: 'turn-aborted' };
          return;
        }
        yield { type: 'text-delta', text: `Echo: ${prompt}` };
        yield { type: 'turn-completed', sessionId: `sess-${nummer}` };
      })();
      return {
        events,
        abort: () => {
          abgebrochen = true;
          abbruch();
        },
      };
    },
  };
  return { runner, starts, laeufe };
}

/**
 * Db-Hülle, die den `insertMessage`-Insert gezielt anhalten kann: erst wenn
 * das `tor` auflöst, kehrt das await in `insertMessage` zurück. Damit lassen
 * sich die Races im Fenster „User-Zeile wird geschrieben" DETERMINISTISCH
 * erzwingen, statt sie per sleep zu erraten. Die echte Insert-Ausführung läuft
 * vorher vollständig — nur die Rückgabe an den ChatService wird verzögert.
 */
function dbMitInsertTor(
  db: Db,
  greift: (werte: Record<string, unknown>) => boolean,
  tor: () => Promise<void>,
): Db {
  const echterInsert = db.insert.bind(db) as (tabelle: unknown) => {
    values: (werte: unknown) => { returning: () => Promise<unknown> };
  };
  return new Proxy(db, {
    get(ziel, eigenschaft, empfaenger): unknown {
      if (eigenschaft !== 'insert') return Reflect.get(ziel, eigenschaft, empfaenger);
      return (tabelle: unknown) => ({
        values: (werte: Record<string, unknown>) => ({
          returning: async (): Promise<unknown> => {
            const zeilen = await echterInsert(tabelle).values(werte).returning();
            if (greift(werte)) await tor();
            return zeilen;
          },
        }),
      });
    },
  }) as Db;
}

/**
 * Das Gegenwartsmodell: „Stop heißt Stop — Gegenwart, kein aufgeschobener
 * Wunsch." Ein Abbruch wirkt SYNCHRON auf den Turn, der JETZT aktiv ist
 * (läuft mit Handle ODER startet gerade), und erzeugt keine Verpflichtung,
 * die in die Zukunft reist. Die Matrix deckt die drei historischen Fehler
 * ab: #5 (verlorene frühere Queue-Nachricht), #6 (Stop ins Leere bricht die
 * nächste Nachricht ab), #7 (Interrupt bricht die eigene Nachricht ab).
 */
describe('Gegenwartsmodell: Stop/Interrupt treffen nur den JETZT aktiven Turn', () => {
  test('(1) Stop während laufendem Turn: abgebrochen, kein Retry, Abbruch sichtbar', async () => {
    const starts: string[] = [];
    const { owner, service, projectId, turnEnds } = await setupChat(
      abbrechbarerRunner(starts, 10_000),
    );
    await service.sendMessage(owner, sendInput(projectId, 'lange Aufgabe'));
    await waitFor(() => starts.length === 1);

    await service.stopTurn(owner, projectId);
    await waitFor(() => !service.isTurnActive(projectId), 15_000);

    expect(starts).toEqual(['lange Aufgabe']); // kein zweiter Versuch
    expect(turnEnds).toEqual([]); // kein onTurnEnd → kein Auto-Commit
    const messages = await service.listMessages(projectId);
    expect(messages.find((m) => m.role === 'system')?.content).toContain('abgebrochen');
  });

  test('(2) Stop ins Leere ist ein No-op — eine danach gesendete Nachricht läuft normal (#6)', async () => {
    // Vorher setzte ein Stop ohne laufenden Turn ein Zeitfenster, das die
    // NÄCHSTE, unabhängige Nachricht abbrach (#6). Produktentscheid
    // „Gegenwart": nichts läuft = nichts zu stoppen = nichts passiert — auch
    // für eine UNMITTELBAR danach eintreffende Nachricht (die alte
    // R6-Reihenfolge-Race wird bewusst nicht mehr rückwirkend gestoppt).
    const starts: string[] = [];
    const { owner, service, projectId } = await setupChat(abbrechbarerRunner(starts, 20));

    await service.stopTurn(owner, projectId); // nichts läuft, nichts in der Queue
    await service.sendMessage(owner, sendInput(projectId, 'ganz normaler Prompt'));
    await waitFor(() => !service.isTurnActive(projectId), 15_000);

    expect(starts).toEqual(['ganz normaler Prompt']);
    const messages = await service.listMessages(projectId);
    expect(messages.find((m) => m.content.includes('zweiter Versuch'))).toBeUndefined();
    expect(messages.find((m) => m.role === 'system')).toBeUndefined();
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'fertig')).toBe(true);
  });

  test('(3) Stop im Startfenster (Handle fehlt noch) trifft genau den startenden Turn — und nur ihn', async () => {
    // Deterministische Race: der echte Turn ist schon AKTIV (die Pump hat ihn
    // aus der Queue genommen), hängt aber im await auf den Config-Warmup —
    // sein Handle steht noch nicht. Der Stop muss sich an GENAU diesen Turn
    // pinnen und wird eingelöst, sobald das Handle steht.
    let releaseWarmup: () => void = () => {};
    let warmupGestartet = false;
    const echt = steuerbarerRunner();
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        if (options.prompt.includes('bereit')) {
          // Der stille Config-Warmup — blockiert, bis der Test ihn freigibt.
          warmupGestartet = true;
          const events = (async function* (): AsyncGenerator<AgentEvent> {
            await new Promise<void>((resolve) => {
              releaseWarmup = resolve;
            });
            yield { type: 'turn-completed', sessionId: null };
          })();
          return { events, abort: () => {} };
        }
        return echt.runner.startTurn(options);
      },
    };
    const { owner, service, projectId, turnEnds } = await setupChat(runner);

    await service.prewarm(owner, projectId, '/tmp/ws');
    await waitFor(() => warmupGestartet);
    await service.sendMessage(owner, sendInput(projectId, 'echte Aufgabe'));
    expect(echt.starts).toHaveLength(0); // Turn aktiv, aber Handle steht noch nicht

    await service.stopTurn(owner, projectId);
    releaseWarmup();
    await waitFor(() => !service.isTurnActive(projectId), 15_000);

    // Der startende Turn wurde beim Handle-Setzen abgebrochen — kein Retry.
    expect(echt.starts).toHaveLength(1);
    expect(echt.laeufe[0]?.abgebrochen()).toBe(true);
    expect(turnEnds).toEqual([]);
    const messages = await service.listMessages(projectId);
    expect(messages.find((m) => m.role === 'system')?.content).toContain('abgebrochen');

    // Und NUR ihn: eine spätere, unabhängige Nachricht läuft normal.
    await service.sendMessage(owner, sendInput(projectId, 'späterer Prompt'));
    await waitFor(() => echt.starts.length === 2);
    echt.laeufe[1]?.fertigstellen();
    await waitFor(() => !service.isTurnActive(projectId));
    expect(echt.laeufe[1]?.abgebrochen()).toBe(false);
  });

  test('(4) Interrupt bricht den laufenden Turn ab und bearbeitet die neue Nachricht', async () => {
    const ctrl = steuerbarerRunner();
    const { owner, service, projectId, turnEnds } = await setupChat(ctrl.runner);
    await service.sendMessage(owner, sendInput(projectId, 'alte Aufgabe'));
    await waitFor(() => ctrl.starts.length === 1);

    await service.sendMessage(owner, { ...sendInput(projectId, 'neue Aufgabe'), interrupt: true });

    await waitFor(() => ctrl.laeufe[0]?.abgebrochen() === true);
    await waitFor(() => ctrl.starts.length === 2);
    expect(ctrl.starts[1]).toContain('neue Aufgabe');
    ctrl.laeufe[1]?.fertigstellen();
    await waitFor(() => !service.isTurnActive(projectId));

    expect(ctrl.laeufe[1]?.abgebrochen()).toBe(false);
    expect(turnEnds).toEqual(['neue Aufgabe']);
    const messages = await service.listMessages(projectId);
    expect(messages.some((m) => m.role === 'system' && m.content.includes('abgebrochen'))).toBe(
      true,
    );
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('neue Aufgabe'))).toBe(
      true,
    );
  });

  test('(5) Interrupt im Leerlauf: die neue Nachricht läuft normal und wird nicht abgebrochen', async () => {
    const ctrl = steuerbarerRunner();
    const { owner, service, projectId, turnEnds } = await setupChat(ctrl.runner);

    await service.sendMessage(owner, { ...sendInput(projectId, 'neue Richtung'), interrupt: true });
    await waitFor(() => ctrl.starts.length === 1);
    ctrl.laeufe[0]?.fertigstellen();
    await waitFor(() => !service.isTurnActive(projectId));

    expect(ctrl.starts).toEqual(['neue Richtung']);
    expect(ctrl.laeufe[0]?.abgebrochen()).toBe(false);
    expect(turnEnds).toEqual(['neue Richtung']);
    expect(
      (await service.listMessages(projectId)).find((m) => m.role === 'system'),
    ).toBeUndefined();
  });

  test('(6) Interrupt trifft nie die eigene Nachricht — auch wenn die Pump sie schon gestartet hat (#7)', async () => {
    // DIE Race hinter Fehler #7: sendMessage(interrupt) hängt im
    // insertMessage-await; währenddessen endet der vorige Turn und die Pump
    // startet die NEUE Nachricht — currentHandle zeigt schon auf sie, wenn der
    // interrupt-Zweig weiterläuft. Deterministisch erzwungen über ein Tor im
    // Insert der neuen User-Zeile.
    const db = createTestDb();
    const owner = await createUser(db, 'marco');
    const projectId = await createProjectRow(db, owner);
    const ctrl = steuerbarerRunner();
    let tor: (() => Promise<void>) | null = null;
    const gatedDb = dbMitInsertTor(
      db,
      (werte) => werte['role'] === 'user' && werte['content'] === 'neue Aufgabe',
      async () => {
        await tor?.();
      },
    );
    const service = new ChatService(gatedDb, ctrl.runner, {}, {});

    await service.sendMessage(owner, sendInput(projectId, 'alte Aufgabe'));
    await waitFor(() => ctrl.starts.length === 1);

    tor = async () => {
      ctrl.laeufe[0]?.fertigstellen(); // der vorige Turn endet GENAU JETZT …
      await waitFor(() => ctrl.starts.length === 2); // … und die Pump startet die neue
    };
    await service.sendMessage(owner, { ...sendInput(projectId, 'neue Aufgabe'), interrupt: true });

    // Die eigene neue Nachricht darf NIEMALS Ziel des Abbruchs sein.
    expect(ctrl.laeufe[1]?.abgebrochen()).toBe(false);
    ctrl.laeufe[1]?.fertigstellen();
    await waitFor(() => !service.isTurnActive(projectId));
    const messages = await service.listMessages(projectId);
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('neue Aufgabe'))).toBe(
      true,
    );
    expect(messages.some((m) => m.content.includes('abgebrochen'))).toBe(false);
  });

  test('(7) Interrupt mit Queue [Z, Y]: die früher eingereihte Nachricht Z geht NICHT verloren (#5)', async () => {
    // Exakt der historische Fehler #5: Z ist eingereiht, aber noch nicht
    // gestartet (ihr Insert hängt noch), da kommt Y mit interrupt. Der alte,
    // aufgeschobene Wunsch („brich den nächsten Turn ab, außer Y") traf dann
    // Z — die Nachricht ging verloren. Im Gegenwartsmodell läuft nichts →
    // der Interrupt ist ein No-op, Z und Y laufen beide normal.
    const db = createTestDb();
    const owner = await createUser(db, 'marco');
    const projectId = await createProjectRow(db, owner);
    const ctrl = steuerbarerRunner();
    let oeffneZ: () => void = () => {};
    const zTor = new Promise<void>((resolve) => {
      oeffneZ = resolve;
    });
    const gatedDb = dbMitInsertTor(
      db,
      (werte) => werte['role'] === 'user' && werte['content'] === 'Z wartet',
      () => zTor,
    );
    const turnEnds: string[] = [];
    const service = new ChatService(
      gatedDb,
      ctrl.runner,
      {
        onTurnEnd: async (_id, prompt) => {
          turnEnds.push(prompt);
        },
      },
      {},
    );

    const zGesendet = service.sendMessage(owner, sendInput(projectId, 'Z wartet')); // Queue: [Z]
    const yGesendet = service.sendMessage(owner, {
      ...sendInput(projectId, 'Y steuert'),
      interrupt: true,
    }); // Queue: [Z, Y]
    oeffneZ();
    await Promise.all([zGesendet, yGesendet]);

    await waitFor(() => ctrl.starts.length === 1);
    expect(ctrl.starts[0]).toContain('Z wartet'); // Z läuft — nicht verloren
    expect(ctrl.laeufe[0]?.abgebrochen()).toBe(false);
    ctrl.laeufe[0]?.fertigstellen();
    await waitFor(() => ctrl.starts.length === 2);
    expect(ctrl.starts[1]).toContain('Y steuert');
    ctrl.laeufe[1]?.fertigstellen();
    await waitFor(() => !service.isTurnActive(projectId));

    expect(ctrl.laeufe[0]?.abgebrochen()).toBe(false);
    expect(ctrl.laeufe[1]?.abgebrochen()).toBe(false);
    expect(turnEnds).toEqual(['Z wartet', 'Y steuert']);
    expect(
      (await service.listMessages(projectId)).some((m) => m.content.includes('abgebrochen')),
    ).toBe(false);
  });

  test('(8) Doppelter Stop ist idempotent und berührt keinen späteren Turn', async () => {
    const ctrl = steuerbarerRunner();
    const { owner, service, projectId } = await setupChat(ctrl.runner);
    await service.sendMessage(owner, sendInput(projectId, 'läuft gerade'));
    await waitFor(() => ctrl.starts.length === 1);

    await service.stopTurn(owner, projectId);
    await waitFor(() => !service.isTurnActive(projectId));
    await service.stopTurn(owner, projectId); // Doppelklick / veralteter turnActive-Stand: No-op

    await service.sendMessage(owner, sendInput(projectId, 'unbeteiligter Turn danach'));
    await waitFor(() => ctrl.starts.length === 2);
    ctrl.laeufe[1]?.fertigstellen();
    await waitFor(() => !service.isTurnActive(projectId));

    expect(ctrl.laeufe[1]?.abgebrochen()).toBe(false);
    const messages = await service.listMessages(projectId);
    const abbrueche = messages.filter(
      (m) => m.role === 'system' && m.content.includes('abgebrochen'),
    );
    expect(abbrueche).toHaveLength(1); // nur der erste Stop hat gewirkt
  });

  test('(9) Stop während eines Flake-Versuchs: kein Retry rettet den gestoppten Turn', async () => {
    // abbrechbarerRunner liefert nach dem Abbruch NUR `turn-aborted` — kein
    // „sinnvolles" Event. Ohne das benutzerAbbruch-Signal würde runTurn das
    // als msb-Flake werten und denselben Prompt ein zweites Mal starten —
    // diesmal ohne Stop; der Agent führte die gestoppte Arbeit vollständig aus.
    const starts: string[] = [];
    const { owner, service, projectId, turnEnds } = await setupChat(
      abbrechbarerRunner(starts, 10_000),
    );
    await service.sendMessage(owner, sendInput(projectId, 'gestoppte Arbeit'));
    await waitFor(() => starts.length === 1);

    await service.stopTurn(owner, projectId);
    await waitFor(() => !service.isTurnActive(projectId), 15_000);
    await Bun.sleep(100); // Gelegenheit für einen fälschlichen zweiten Versuch

    expect(starts).toEqual(['gestoppte Arbeit']);
    expect(turnEnds).toEqual([]);
    const messages = await service.listMessages(projectId);
    expect(messages.find((m) => m.content.includes('zweiter Versuch'))).toBeUndefined();
    expect(messages.find((m) => m.role === 'system')?.content).toContain('abgebrochen');
  });
});

describe('Config-Warmup: Robustheit', () => {
  test('ein DB-Fehler im Warmup reißt den Serverprozess nicht mit', async () => {
    // schema/index.ts startet prewarm als `void ...` ohne Rejection-Handler.
    // Die DB-Abfrage in prewarm lag ausserhalb jedes try/catch — eine
    // SQLITE_BUSY beim Öffnen eines Projekts beendete damit den ganzen Server
    // und riss alle anderen Sitzungen und MicroVMs mit.
    const db = createTestDb();
    const owner = await createUser(db, 'marco');
    const projectId = await createProjectRow(db, owner);
    const kaputteDb = new Proxy(db, {
      get(ziel, eigenschaft, empfaenger): unknown {
        if (eigenschaft === 'select') {
          return () => {
            throw new Error('SQLITE_BUSY: database is locked');
          };
        }
        return Reflect.get(ziel, eigenschaft, empfaenger);
      },
    }) as Db;
    const service = new ChatService(kaputteDb, new FakeAgentRunner(1), {}, {});

    await expect(service.prewarm(owner, projectId, '/tmp/ws')).resolves.toBeUndefined();
  });

  test('nach einem beendeten Warmup ist erneutes Vorwärmen möglich', async () => {
    // Der warmups-Eintrag wurde nie entfernt. prewarm war danach für dieses
    // Projekt dauerhaft ein No-Op — auch wenn das Projekt geschlossen und mit
    // einer FRISCHEN VM wieder geöffnet wurde, deren Config wieder kalt ist.
    const prompts: string[] = [];
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        prompts.push(options.prompt);
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn-completed', sessionId: null };
        })();
        return { events, abort: () => {} };
      },
    };
    const { owner, service, projectId } = await setup(runner);

    await service.prewarm(owner, projectId, '/tmp/ws');
    await waitFor(() => prompts.length === 1);
    await Bun.sleep(50); // Warmup zu Ende laufen lassen

    await service.prewarm(owner, projectId, '/tmp/ws');
    await waitFor(() => prompts.length === 2);

    expect(prompts.length).toBe(2);
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
    const { owner, service, projectId } = await setup(retryRunner);
    await service.sendMessage(owner, sendInput(projectId, 'Hallo'));
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
    const { owner, service, projectId } = await setup();
    await service.sendMessage(owner, sendInput(projectId, 'FEHLER provozieren'));
    await waitFor(() => !service.isTurnActive(projectId));

    const messages = await service.listMessages(projectId);
    expect(messages.some((m) => m.role === 'error')).toBe(true);
  });
});

describe('Hooks & Session (R8/R9)', () => {
  test('meldet Agent-Aktivität, ruft onTurnEnd und persistiert die Claude-Session', async () => {
    const { owner, db, service, projectId, turnEnds, activity } = await setup();
    await service.sendMessage(owner, sendInput(projectId, 'Hallo'));
    await waitFor(() => turnEnds.length === 1);

    expect(turnEnds).toEqual(['Hallo']);
    expect(activity.length).toBeGreaterThan(0);
    expect(activity[0]).toBe(projectId);

    const row = (await db.select().from(projects).where(eq(projects.id, projectId)))[0];
    expect(row?.claudeSessionId).toBe('fake-session');
  });
});

/**
 * F16: Ein kompromittierter Daemon konnte eine Chat-Zeile unbegrenzt wachsen
 * lassen — jedes Delta schreibt die KOMPLETTE Zeile per UPDATE und broadcastet
 * sie an alle Abonnenten.
 */
describe('Delta-Deckel gegen unbegrenztes Wachstum (F16)', () => {
  test('bricht in neue Zeilen um, ohne Inhalt zu verlieren', async () => {
    const chunk = 'x'.repeat(10_000);
    const anzahl = 30;
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        return {
          abort: () => {},
          events: (async function* () {
            for (let i = 0; i < anzahl; i += 1) {
              yield { type: 'text-delta', text: chunk } as AgentEvent;
            }
            yield { type: 'turn-completed', sessionId: null } as AgentEvent;
          })(),
        };
      },
    };
    const { owner, service, projectId } = await setup(runner);

    await service.sendMessage(owner, sendInput(projectId, 'los'));
    await waitFor(async () => !service.isTurnActive(projectId));

    const zeilen = (await service.listMessages(projectId)).filter((m) => m.role === 'assistant');
    expect(zeilen.length).toBeGreaterThan(1);
    for (const zeile of zeilen) {
      expect(zeile.content.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    }
    expect(zeilen.map((z) => z.content).join('').length).toBe(anzahl * chunk.length);
  });
});

/**
 * Der stille Config-Warmup blockiert den echten Turn: runAttempt wartet auf
 * ihn, BEVOR es in seine eigene Timeout-Schleife kommt. Ohne Frist hängt ein
 * stummer Warmup das Projekt unbegrenzt auf — im UI steht ewig „Agent
 * arbeitet", ohne dass je ein Fehler sichtbar wird. Live reproduziert mit
 * einem nicht antwortenden Upstream.
 */
describe('Config-Warmup hat eine Frist', () => {
  test('ein stummer Warmup blockiert den echten Turn nicht', async () => {
    let warmupAbgebrochen = false;
    let turnNummer = 0;
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        turnNummer += 1;
        if (turnNummer === 1) {
          // Warmup: liefert NIE ein Event.
          return {
            abort: () => {
              warmupAbgebrochen = true;
            },
            // Liefert nie ein Event — steht für einen Upstream, der nicht antwortet.
            events: {
              [Symbol.asyncIterator]() {
                return { next: () => new Promise<IteratorResult<AgentEvent>>(() => {}) };
              },
            } as AsyncIterable<AgentEvent>,
          };
        }
        return {
          abort: () => {},
          events: (async function* () {
            yield { type: 'text-delta', text: 'fertig' } as AgentEvent;
            yield { type: 'turn-completed', sessionId: null } as AgentEvent;
          })(),
        };
      },
    };
    const db = createTestDb();
    const owner = await createUser(db, 'marco');
    const projectId = await createProjectRow(db, owner);
    const service = new ChatService(db, runner, {}, { agentWarmupTimeoutMs: 300 });

    await service.prewarm(owner, projectId, '/tmp/fake');
    await service.sendMessage(owner, sendInput(projectId, 'Hallo'));
    await waitFor(async () => !service.isTurnActive(projectId), 10_000);

    expect(warmupAbgebrochen).toBe(true);
    const antwort = (await service.listMessages(projectId)).filter((m) => m.role === 'assistant');
    expect(antwort.map((m) => m.content).join('')).toContain('fertig');
  });
});

/**
 * ChatService.states wuchs unbegrenzt: Queue, Subscriber und currentHandle
 * eines Projekts blieben fuer die Lebensdauer des Prozesses liegen — auch
 * nachdem das Projekt geloescht wurde.
 */
describe('forget: Zustand geloeschter Projekte freigeben', () => {
  test('entfernt den Projektzustand', async () => {
    const { owner, service, projectId } = await setup();
    await service.sendMessage(owner, sendInput(projectId, 'hallo'));
    await waitFor(() => !service.isTurnActive(projectId));
    expect(service.trackedProjects()).toBe(1);

    service.forget(projectId);

    expect(service.trackedProjects()).toBe(0);
  });

  test('bricht einen laufenden Turn ab, statt ihn verwaisen zu lassen', async () => {
    let abgebrochen = false;
    let gestartet = false;
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        gestartet = true;
        let abbrechen: () => void = () => {};
        const abgewartet = new Promise<void>((resolve) => {
          abbrechen = resolve;
        });
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          await abgewartet;
          yield { type: 'turn-aborted' };
        })();
        return {
          events,
          abort: () => {
            abgebrochen = true;
            abbrechen();
          },
        };
      },
    };
    const { owner, service, projectId } = await setup(runner);
    await service.sendMessage(owner, sendInput(projectId, 'laeuft noch'));
    await waitFor(() => gestartet);

    service.forget(projectId);

    // Ohne Abbruch liefe der Turn weiter und schriebe in ein Projekt, das es
    // nicht mehr gibt — inklusive Auto-Commit in dessen Branch.
    expect(abgebrochen).toBe(true);
  });

  test('Retry nach forget() legt den Projektzustand NICHT neu an (Leck)', async () => {
    // Fenster: Versuch 1 flaked (kein einziges Event → Retry stünde an);
    // ZWISCHEN den Versuchen wird das Projekt per forget() gelöscht. Der
    // zweite Versuch holte den State über das lazy-anlegende state() zurück —
    // ein leerer Eintrag, der für die Prozesslebensdauer liegen bliebe, und
    // der Agent liefe für ein Projekt, das es nicht mehr gibt.
    const db = createTestDb();
    const owner = await createUser(db, 'marco');
    const projectId = await createProjectRow(db, owner);
    let starts = 0;
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        starts += 1;
        const erster = starts === 1;
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          if (erster) {
            // Transport-Flake: stirbt sofort, ohne je ein Event zu liefern.
            yield { type: 'turn-aborted' };
            return;
          }
          yield { type: 'text-delta', text: 'dürfte nie laufen' };
          yield { type: 'turn-completed', sessionId: 's' };
        })();
        return { events, abort: () => {} };
      },
    };
    // Tor auf der „zweiter Versuch"-Systemzeile (der einzige system-Insert in
    // diesem Ablauf): forget() landet damit DETERMINISTISCH zwischen den
    // beiden Versuchen, statt das Fenster per sleep zu erraten.
    let forgetJetzt: () => void = () => {};
    const gatedDb = dbMitInsertTor(
      db,
      (werte) => werte['role'] === 'system',
      async () => {
        forgetJetzt();
      },
    );
    const service = new ChatService(gatedDb, runner, {}, {});
    forgetJetzt = () => {
      service.forget(projectId);
    };

    await service.sendMessage(owner, sendInput(projectId, 'flaket gleich'));
    await waitFor(() => starts >= 1);
    await Bun.sleep(100); // Gelegenheit für den fälschlichen zweiten Versuch

    expect(starts).toBe(1); // kein Retry für ein gelöschtes Projekt
    expect(service.trackedProjects()).toBe(0); // kein neu angelegter State (das Leck)
  });
});

describe('Re-Entry-Resume (resumeUnansweredTurn)', () => {
  /** Runner, der jede Turn-Option festhält und den Turn sofort sauber beendet. */
  function fangenderRunner(): { runner: AgentRunner; gesehen: TurnOptions[] } {
    const gesehen: TurnOptions[] = [];
    const runner: AgentRunner = {
      startTurn(options: TurnOptions): TurnHandle {
        gesehen.push(options);
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text-delta', text: 'wieder da' };
          yield { type: 'turn-completed', sessionId: 's' };
        })();
        return { events, abort: () => {} };
      },
    };
    return { runner, gesehen };
  }

  test('unbeantwortete letzte User-Zeile → Turn läuft mit ORIGINALER turnId, keine zweite User-Zeile', async () => {
    const cap = fangenderRunner();
    const { owner, service, projectId } = await setupChat(cap.runner);
    await service.postMessage(projectId, 'user', 'Bau ein Memory-Spiel');
    const userRow = (await service.listMessages(projectId))[0];
    expect(userRow).toBeDefined();

    const resumed = await service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace');

    expect(resumed).toBe(true);
    await waitFor(() => !service.isTurnActive(projectId));
    const messages = await service.listMessages(projectId);
    // KEINE zweite User-Zeile — sonst entstünde bei jedem Host-Neustart ein
    // Duplikat der User-Bubble.
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    // Die Antwort gruppiert sich über die ORIGINALE turnId unter derselben Bubble.
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('wieder da');
    expect(assistant?.turnId).toBe(userRow?.turnId ?? '');
    expect(cap.gesehen).toHaveLength(1);
    expect(cap.gesehen[0]?.prompt).toContain('Bau ein Memory-Spiel');
    expect(cap.gesehen[0]?.workspaceDir).toBe('/tmp/fake-workspace');
  });

  test('letzte Zeile ist eine assistant-Antwort → false, kein Turn, keine neuen Zeilen', async () => {
    const cap = fangenderRunner();
    const { owner, service, projectId } = await setupChat(cap.runner);
    await service.postMessage(projectId, 'user', 'Bau was');
    await service.postMessage(projectId, 'assistant', 'Fertig gebaut.');
    const vorher = (await service.listMessages(projectId)).length;

    expect(await service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace')).toBe(false);

    await Bun.sleep(30);
    expect(service.isTurnActive(projectId)).toBe(false);
    expect(cap.gesehen).toHaveLength(0);
    expect((await service.listMessages(projectId)).length).toBe(vorher);
  });

  test('letzte Zeile ist die „Turn abgebrochen"-Systemzeile (Nutzer-Stop) → false', async () => {
    const cap = fangenderRunner();
    const { owner, service, projectId } = await setupChat(cap.runner);
    await service.postMessage(projectId, 'user', 'Bau was');
    await service.postMessage(projectId, 'system', 'Turn abgebrochen');

    expect(await service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace')).toBe(false);

    await Bun.sleep(30);
    expect(cap.gesehen).toHaveLength(0);
  });

  test('leere Historie → false', async () => {
    const cap = fangenderRunner();
    const { owner, service, projectId } = await setupChat(cap.runner);

    expect(await service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace')).toBe(false);

    await Bun.sleep(30);
    expect(cap.gesehen).toHaveLength(0);
    expect((await service.listMessages(projectId)).length).toBe(0);
  });

  test('läuft bereits ein Turn → false, kein zweites Enqueue (Guard)', async () => {
    let release: () => void = () => {};
    let starts = 0;
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        starts += 1;
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          await new Promise<void>((r) => {
            release = r;
          });
          yield { type: 'turn-completed', sessionId: 's' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { owner, service, projectId } = await setupChat(runner);
    await service.sendMessage(owner, sendInput(projectId, 'läuft gerade'));
    await waitFor(() => starts === 1);

    // Die letzte Zeile IST eine (noch unbeantwortete) User-Zeile — trotzdem
    // kein Resume: im selben Prozess läuft der Turn ja noch.
    expect(await service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace')).toBe(false);

    release();
    await waitFor(() => !service.isTurnActive(projectId));
    expect(starts).toBe(1);
  });

  test('Race: zwei gleichzeitige Aufrufe (zwei Tabs / StrictMode-Doppel-Effekt) reihen den Turn nur EINMAL ein', async () => {
    // Check-then-act über ein await: der Doppellauf-Guard lief VOR dem
    // listMessages-await, gepusht wurde danach. Zwei gleichzeitige
    // enterProject-Aufrufe (zwei Tabs; im Dev-Modus der React-StrictMode-
    // Doppel-Effekt) passierten BEIDE den Guard, warteten beide auf die DB
    // und reihten beide denselben Turn (originale turnId) ein — doppelte
    // Agent-Arbeit, doppelte Antwort-Zeilen, zwei Auto-Commits.
    let starts = 0;
    const runner: AgentRunner = {
      startTurn(): TurnHandle {
        starts += 1;
        const events = (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text-delta', text: 'wieder da' };
          yield { type: 'turn-completed', sessionId: 's' };
        })();
        return { events, abort: () => {} };
      },
    };
    const { owner, service, projectId } = await setupChat(runner);
    await service.postMessage(projectId, 'user', 'Bau ein Memory-Spiel');

    // Beide Aufrufe passieren ihren synchronen Vorab-Guard, BEVOR der jeweils
    // andere seinen Push erreicht — exakt das Fenster des Races. Das erste
    // await (listMessages) suspendiert deterministisch beide.
    const ergebnisse = await Promise.all([
      service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace'),
      service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace'),
    ]);

    // Genau EINER der Aufrufe gewinnt.
    expect(ergebnisse.filter((r) => r)).toHaveLength(1);
    await waitFor(() => !service.isTurnActive(projectId));
    await Bun.sleep(50); // Gelegenheit für einen fälschlichen zweiten Lauf
    expect(starts).toBe(1); // der Runner startet den Turn genau EINMAL
    const messages = await service.listMessages(projectId);
    // Keine doppelten Antwort-Zeilen unter derselben Bubble.
    expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  test('Idempotenz: zweiter Aufruf direkt nach erfolgreichem Resume → false', async () => {
    const cap = fangenderRunner();
    const { owner, service, projectId } = await setupChat(cap.runner);
    await service.postMessage(projectId, 'user', 'Bau ein Quiz');

    expect(await service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace')).toBe(true);
    // Sofort danach ist der wiederaufgenommene Turn aktiv (Queue/Pump) —
    // der Guard verhindert den Doppellauf.
    expect(await service.resumeUnansweredTurn(owner, projectId, '/tmp/fake-workspace')).toBe(false);

    await waitFor(() => !service.isTurnActive(projectId));
    expect(cap.gesehen).toHaveLength(1);
    expect((await service.listMessages(projectId)).filter((m) => m.role === 'user')).toHaveLength(
      1,
    );
  });
});
