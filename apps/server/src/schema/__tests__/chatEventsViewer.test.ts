import { describe, expect, test } from 'bun:test';
import { parse, subscribe } from 'graphql';
import { FakeAgentRunner } from '../../agent/fakeRunner';
import { loadConfig } from '../../config';
import { projects } from '../../db/schema';
import type { SandboxContext, SandboxHandle, SandboxProvider } from '../../sandbox/provider';
import { SandboxManager } from '../../sandbox/sandboxManager';
import { ChatService } from '../../services/chatService';
import { createTestDb, createUser } from '../../services/__tests__/testUtils';
import type { GraphQLContext } from '../builder';
import { schema } from '../index';

/**
 * H11 (#2/#7): Der Betrachter-Refcount haengt an der LEBENSDAUER der
 * chatEvents-Subscription — enter beim Aufbau, leave beim Ende des Iterators.
 * Genau dieses Ende feuert der GraphQL-Server auch bei Tab-Schliessen, Reload,
 * Crash und Netzabriss (er ruft `.return()` auf dem Iterator) — das
 * verlaessliche Signal, das die alten enter/leave-Mutationen nie hatten.
 */

function fakeRequest(signal?: AbortSignal): Request {
  const request = new Request('http://mac.local:4000/graphql', signal ? { signal } : {});
  // readSessionToken erwartet den CookieStore des Yoga-Plugins am Request.
  Object.assign(request, {
    cookieStore: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    },
  });
  return request;
}

interface Setup {
  manager: SandboxManager;
  stopCalls: string[];
  contextFor: (username: string) => Promise<GraphQLContext>;
}

async function setupSchemaTest(graceMs = 30, startDelayMs = 0): Promise<Setup> {
  const db = createTestDb();
  const owner = await createUser(db); // 'marco', erster Nutzer → approved
  await db.insert(projects).values({
    id: 'p1',
    name: 'Testprojekt',
    branchName: 'marco/testprojekt',
    templateDir: 'pwa',
    devCommand: 'bun run dev',
    previewPort: 5173,
    ownerId: owner.id,
  });

  const stopCalls: string[] = [];
  const provider: SandboxProvider = {
    async start(context: SandboxContext): Promise<SandboxHandle> {
      // Simuliert den (bei kaltem Boot sekundenlangen) VM-Start.
      if (startDelayMs > 0) await Bun.sleep(startDelayMs);
      return {
        previewHostPort: 1,
        previewStatus: () => 'ready' as const,
        stop: async () => {
          stopCalls.push(context.projectId);
        },
      };
    },
  };
  const manager = new SandboxManager({ provider, graceMs, idleMs: 10_000, maxSandboxes: 8 });
  const chatService = new ChatService(db, new FakeAgentRunner(1), {});
  const config = loadConfig();

  const contextFor = async (username: string): Promise<GraphQLContext> => {
    const user = username === 'marco' ? owner : await createUser(db, username);
    return {
      db,
      config,
      currentUser: user,
      request: fakeRequest(),
      sandboxManager: manager,
      chatService,
      clientIp: null,
    };
  };

  return { manager, stopCalls, contextFor };
}

const CHAT_EVENTS_DOC = parse(/* GraphQL */ `
  subscription {
    chatEvents(projectId: "p1") {
      turnActive
    }
  }
`);

async function subscribeChatEvents(
  context: GraphQLContext,
): Promise<AsyncIterableIterator<unknown>> {
  const result = await subscribe({ schema, document: CHAT_EVENTS_DOC, contextValue: context });
  if (!(Symbol.asyncIterator in result)) {
    throw new Error(`Subscription nicht aufgebaut: ${JSON.stringify(result)}`);
  }
  return result as AsyncIterableIterator<unknown>;
}

describe('chatEvents-Subscription treibt den Betrachter-Refcount (H11)', () => {
  test('der Aufbau der Subscription betritt die Sandbox (enter beim Start)', async () => {
    const { manager, contextFor } = await setupSchemaTest(10_000);
    const stream = await subscribeChatEvents(await contextFor('marco'));

    expect(manager.status('p1')).toBe('running');
    expect(manager.viewerCount('p1')).toBe(1);

    await stream.return?.(undefined);
  });

  test('das Ende der Subscription meldet ab — auch ohne je ein Event konsumiert zu haben', async () => {
    // Genau der Reload-/Crash-/Netzabriss-Fall: der Server bricht den Iterator
    // per .return() ab, moeglicherweise bevor je ein next() lief.
    const { manager, stopCalls, contextFor } = await setupSchemaTest(30);
    const stream = await subscribeChatEvents(await contextFor('marco'));
    expect(manager.viewerCount('p1')).toBe(1);

    await stream.return?.(undefined);

    expect(manager.viewerCount('p1')).toBe(0);
    await Bun.sleep(150);
    expect(manager.status('p1')).toBe('stopped');
    expect(stopCalls).toEqual(['p1']);
  });

  test('ein Nur-Lese-Besucher (R10) zaehlt ueber seine Subscription mit', async () => {
    const { manager, stopCalls, contextFor } = await setupSchemaTest(30);
    const ownerStream = await subscribeChatEvents(await contextFor('marco'));
    const gastStream = await subscribeChatEvents(await contextFor('gast'));
    expect(manager.viewerCount('p1')).toBe(2);

    // Der Eigentuemer geht — der Besucher haelt die Sandbox weiter offen.
    await ownerStream.return?.(undefined);
    await Bun.sleep(150);
    expect(manager.status('p1')).toBe('running');
    expect(stopCalls).toEqual([]);

    // Erst wenn auch der Besucher geht, greift Grace.
    await gastStream.return?.(undefined);
    await Bun.sleep(150);
    expect(manager.status('p1')).toBe('stopped');
  });
});

/**
 * Defekt 3: Der Subscribe-Resolver awaited `enter()` (bei kaltem Boot viele
 * Sekunden). Bricht der Client waehrenddessen ab, existiert noch KEIN
 * Iterator, auf dem Yoga `.return()` rufen koennte — `releaseOnClose` griffe
 * nie, der Betrachter bliebe fuer immer gezaehlt und die VM stoppte nie.
 */
describe('Client-Abbruch waehrend des Sandbox-Starts verwaist keinen Betrachter (Defekt 3)', () => {
  test('ein bereits abgebrochener Request hinterlaesst keinen Betrachter', async () => {
    const { manager, contextFor } = await setupSchemaTest(10_000);
    const context = await contextFor('marco');
    const controller = new AbortController();
    controller.abort();
    context.request = fakeRequest(controller.signal);

    const result = await subscribe({ schema, document: CHAT_EVENTS_DOC, contextValue: context });

    expect(manager.viewerCount('p1')).toBe(0);
    // Kein Iterator, sondern ein ExecutionResult mit Fehler — Yoga hat damit
    // nichts mehr zu disposen.
    expect(Symbol.asyncIterator in result).toBe(false);
  });

  test('bricht der Client WAEHREND enter() ab, wird der Betrachter sofort wieder ausgetragen', async () => {
    const { manager, contextFor } = await setupSchemaTest(10_000, 40);
    const context = await contextFor('marco');
    const controller = new AbortController();
    context.request = fakeRequest(controller.signal);

    const resultPromise = subscribe({ schema, document: CHAT_EVENTS_DOC, contextValue: context });
    await Bun.sleep(10); // enter() haengt noch im Provider-Start
    controller.abort();
    const result = await resultPromise;

    expect(manager.viewerCount('p1')).toBe(0);
    expect(Symbol.asyncIterator in result).toBe(false);
  });
});
