import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '../../agent/events';
import type { AgentRunner, TurnHandle } from '../../agent/runner';
import type { Db } from '../../db/client';
import { projects, type UserRow } from '../../db/schema';
import { ChatService, type ChatEventPayload, type ChatServiceOptions } from '../chatService';
import { createTestDb, createUser, waitFor } from './testUtils';

/**
 * Streaming-Kosten: Jedes Text-Delta schrieb die GANZE Zeile neu in die DB und
 * schickte sie komplett an jeden Abonnenten — quadratisch in der Antwortlänge.
 * Deltas werden deshalb gebündelt (ein Schreib-/Sende-Vorgang pro Zeitfenster),
 * und ein langsamer Abonnent hält pro Zeile nur den neuesten Stand.
 */

interface Steuerung {
  runner: AgentRunner;
  /** Lässt den Runner nach den ersten Events weiterlaufen. */
  weiter: () => void;
}

/** Runner: liefert `vorher` ohne Pause, wartet dann auf `weiter()`, liefert `nachher`. */
function gestufterRunner(vorher: AgentEvent[], nachher: AgentEvent[]): Steuerung {
  let weiter: () => void = () => {};
  const tor = new Promise<void>((resolve) => {
    weiter = resolve;
  });
  const runner: AgentRunner = {
    startTurn(): TurnHandle {
      const events = (async function* (): AsyncGenerator<AgentEvent> {
        yield* vorher;
        await tor;
        yield* nachher;
      })();
      return { events, abort: () => {} };
    },
  };
  return { runner, weiter };
}

async function setup(
  runner: AgentRunner,
  options: ChatServiceOptions,
): Promise<{ db: Db; owner: UserRow; service: ChatService; projectId: string }> {
  const db = createTestDb();
  const owner = await createUser(db, 'marco');
  const projectId = 'projekt-1';
  await db.insert(projects).values({
    id: projectId,
    name: 'Projekt',
    branchName: 'marco/projekt-1',
    templateDir: 'pwa',
    devCommand: 'bun run dev',
    previewPort: 5173,
    ownerId: owner.id,
  });
  const service = new ChatService(db, runner, {}, { prewarmEnabled: false, ...options });
  return { db, owner, service, projectId };
}

const delta = (text: string): AgentEvent => ({ type: 'text-delta', text });
const fertig: AgentEvent = { type: 'turn-completed', sessionId: null };

async function assistantInhalt(service: ChatService, projectId: string): Promise<string[]> {
  const messages = await service.listMessages(projectId);
  return messages.filter((m) => m.role === 'assistant').map((m) => m.content);
}

function senden(service: ChatService, owner: UserRow, projectId: string): Promise<unknown> {
  return service.sendMessage(owner, {
    projectId,
    workspaceDir: '/tmp/fake-workspace',
    text: 'Hallo',
  });
}

describe('Streaming: Deltas werden gebündelt', () => {
  test('innerhalb des Zeitfensters wird nicht jedes Delta in die DB geschrieben', async () => {
    const ctrl = gestufterRunner([delta('a'), delta('b'), delta('c')], [fertig]);
    const { service, owner, projectId } = await setup(ctrl.runner, { agentDeltaFlushMs: 60_000 });
    await senden(service, owner, projectId);

    // Das erste Delta legt die Zeile sofort an (die Antwort erscheint ohne
    // Verzögerung); die folgenden warten auf das Zeitfenster.
    await waitFor(async () => (await assistantInhalt(service, projectId)).length === 1);
    await Bun.sleep(30);
    expect(await assistantInhalt(service, projectId)).toEqual(['a']);

    ctrl.weiter();
    await waitFor(() => !service.isTurnActive(projectId));
    expect(await assistantInhalt(service, projectId)).toEqual(['abc']);
  });

  test('der Rest wird nach Ablauf des Zeitfensters geschrieben — auch ohne weiteres Event', async () => {
    const ctrl = gestufterRunner([delta('a'), delta('b'), delta('c')], [fertig]);
    const { service, owner, projectId } = await setup(ctrl.runner, { agentDeltaFlushMs: 20 });
    await senden(service, owner, projectId);

    // Der Runner steht am Tor: es kommt KEIN weiteres Event. Der Text muss
    // trotzdem vollständig sichtbar werden (z. B. während der Agent nachdenkt).
    await waitFor(async () => (await assistantInhalt(service, projectId))[0] === 'abc', 2_000);
    expect(service.isTurnActive(projectId)).toBe(true);

    ctrl.weiter();
    await waitFor(() => !service.isTurnActive(projectId));
  });

  test('vor einer neuen Zeile (Tool-Call) ist die laufende Zeile vollständig', async () => {
    const ctrl = gestufterRunner(
      [delta('a'), delta('b'), { type: 'tool-use', name: 'Write', detail: 'x.ts' }],
      [fertig],
    );
    const { service, owner, projectId } = await setup(ctrl.runner, { agentDeltaFlushMs: 60_000 });
    const events: ChatEventPayload[] = [];
    const abo = service.subscribe(projectId);
    void (async () => {
      for await (const event of abo) events.push(event);
    })();
    await senden(service, owner, projectId);

    await waitFor(async () =>
      (await service.listMessages(projectId)).some((m) => m.role === 'tool'),
    );
    // DB: Reihenfolge und Inhalt stimmen, obwohl das Zeitfenster nie ablief.
    const rows = await service.listMessages(projectId);
    expect(rows.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Hallo'],
      ['assistant', 'ab'],
      ['tool', 'Write: x.ts'],
    ]);
    // Abonnenten: der vollständige Text kommt VOR der Tool-Zeile an.
    const rollen = events.map((e) => `${e.message.role}:${e.message.content}`);
    expect(rollen.indexOf('assistant:ab')).toBeGreaterThanOrEqual(0);
    expect(rollen.indexOf('assistant:ab')).toBeLessThan(rollen.indexOf('tool:Write: x.ts'));

    ctrl.weiter();
    await waitFor(() => !service.isTurnActive(projectId));
    await abo.return?.();
  });

  test('das Turn-Ende trägt den vollständigen Text und turnActive=false', async () => {
    const ctrl = gestufterRunner([delta('a'), delta('b'), delta('c'), fertig], []);
    ctrl.weiter();
    const { service, owner, projectId } = await setup(ctrl.runner, { agentDeltaFlushMs: 60_000 });
    const events: ChatEventPayload[] = [];
    const abo = service.subscribe(projectId);
    void (async () => {
      for await (const event of abo) events.push(event);
    })();
    await senden(service, owner, projectId);

    await waitFor(() => events.some((e) => !e.turnActive));
    const letztes = events[events.length - 1];
    expect(letztes?.turnActive).toBe(false);
    expect(letztes?.message.content).toBe('abc');
    expect(await assistantInhalt(service, projectId)).toEqual(['abc']);
    await abo.return?.();
  });
});

describe('Streaming: ein langsamer Abonnent hält pro Zeile nur den neuesten Stand', () => {
  test('aufgestaute Stände derselben Zeile fallen zu einem zusammen', async () => {
    // Fenster 0 = jedes Delta sofort senden: so entstehen garantiert mehrere
    // Stände derselben Zeile, während der Abonnent noch nicht liest.
    const ctrl = gestufterRunner([delta('a'), delta('b'), delta('c')], [fertig]);
    const { service, owner, projectId } = await setup(ctrl.runner, { agentDeltaFlushMs: 0 });
    const abo = service.subscribe(projectId);
    await senden(service, owner, projectId);
    await waitFor(async () => (await assistantInhalt(service, projectId))[0] === 'abc');

    // Erst JETZT lesen: im Puffer liegt die User-Zeile und genau EIN Stand der
    // Assistant-Zeile — der neueste.
    const erstes = await abo.next();
    const zweites = await abo.next();
    expect(erstes.value?.message.role).toBe('user');
    expect(zweites.value?.message.role).toBe('assistant');
    expect(zweites.value?.message.content).toBe('abc');

    ctrl.weiter();
    // Danach folgt nur noch das Turn-Ende (dieselbe Zeile, turnActive=false).
    const drittes = await abo.next();
    expect(drittes.value?.message.content).toBe('abc');
    expect(drittes.value?.turnActive).toBe(false);
    await abo.return?.();
  });
});
