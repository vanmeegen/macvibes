import { describe, expect, test } from 'bun:test';
import type { GatewayListener, GatewayNotification } from '../../agent/agentGateway';
import {
  DaemonSession,
  type QueryHandle,
  type SdkUserMessage,
} from '../../agent/daemon/daemonSession';
import type { DaemonToHostMessage, HostToDaemonMessage } from '../../agent/daemon/protocol';
import { DaemonAgentRunner } from '../../agent/daemonRunner';
import { projects } from '../../db/schema';
import { createTestDb, createUser, waitFor } from '../../testing/testUtils';
import { ChatService } from '../chatService';

/**
 * Host und Daemon in EINEM Prozess, ohne VM: ChatService → TurnAttempt →
 * DaemonAgentRunner → (Gateway im Speicher) → DaemonSession → skriptbare
 * SDK-Query.
 *
 * Diese Kette verdrahtete bisher kein Test. Die ChatService-Tests nutzen
 * Runner, deren `abort` synchron wirkt; die Daemon-Tests kennen den Host nicht.
 * Genau in der Lücke dazwischen lagen A2 und A3 der Härtung 2026-11: der Host
 * hielt einen Turn für beendet, der im Daemon noch belegt war.
 */

type Verhalten = 'stumm' | 'antwortet' | 'langsam';

/** Skriptbare SDK-Query: reagiert auf jede Nutzer-Nachricht nach ihrem Verhalten. */
class SkriptQuery implements QueryHandle {
  private queue: unknown[] = [];
  private waiter: (() => void) | null = null;
  private inArbeit = false;
  interrupts = 0;

  constructor(
    private readonly verhalten: Verhalten,
    private readonly sessionId: string,
    prompt: AsyncIterable<SdkUserMessage>,
  ) {
    void (async () => {
      for await (const message of prompt) {
        if (this.verhalten === 'stumm') continue;
        this.inArbeit = true;
        this.push({ type: 'system', subtype: 'init', session_id: this.sessionId });
        if (this.verhalten === 'langsam' && !message.message.content.includes('schnell')) {
          this.pushText('ich arbeite noch …');
          continue; // kein result — der Turn „läuft", bis ihn jemand abbricht
        }
        this.pushText(`Antwort auf: ${message.message.content}`);
        this.push({ type: 'result', subtype: 'success', session_id: this.sessionId });
        this.inArbeit = false;
      }
    })();
  }

  /** Text so, wie ihn das SDK streamt (content_block_delta). */
  private pushText(text: string): void {
    this.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
  }

  private push(message: unknown): void {
    this.queue.push(message);
    this.waiter?.();
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    // Wie das SDK: ein laufender Turn endet mit einem error-result — eine
    // stumme (hängende) Query antwortet auch darauf nicht.
    //
    // Sofort, nicht verzögert: das echte SDK verarbeitet seinen Eingabestrom
    // seriell — der Abbruch beendet den laufenden Turn (result), BEVOR die
    // nächste Nutzer-Nachricht gelesen wird.
    if (this.verhalten !== 'stumm' && this.inArbeit) {
      this.inArbeit = false;
      this.push({ type: 'result', subtype: 'error_during_execution', session_id: this.sessionId });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift();
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
  }
}

/** Gateway im Speicher: reicht Host-Kommandos an die Session, deren Meldungen an den Host. */
class SpeicherGateway {
  private readonly listeners = new Set<GatewayListener>();
  readonly gesendet: HostToDaemonMessage[] = [];
  readonly queries: SkriptQuery[] = [];
  daemonNeustarts = 0;
  private session: DaemonSession;

  constructor(private readonly verhaltenProQuery: Verhalten[]) {
    this.session = this.neueSession();
  }

  private neueSession(): DaemonSession {
    return new DaemonSession({
      cwd: '/work',
      interruptGraceMs: 50,
      emit: (message) => this.melde({ kind: 'message', message }),
      createQuery: (params) => {
        const verhalten = this.verhaltenProQuery[this.queries.length] ?? 'antwortet';
        const query = new SkriptQuery(verhalten, `s-${this.queries.length + 1}`, params.prompt);
        this.queries.push(query);
        return query;
      },
    });
  }

  private melde(notification: GatewayNotification): void {
    // Wie über einen echten Socket: asynchron zugestellt.
    queueMicrotask(() => {
      for (const listener of [...this.listeners]) listener(notification);
    });
  }

  async waitForConnection(): Promise<void> {}

  send(_sandbox: string, message: HostToDaemonMessage): boolean {
    this.gesendet.push(message);
    queueMicrotask(() => {
      if (message.kind === 'start-turn') {
        const quittung: DaemonToHostMessage = { kind: 'turn-started', turnId: message.turnId };
        this.melde({ kind: 'message', message: quittung });
        this.session.startTurn(message);
      } else if (message.kind === 'interrupt') {
        this.session.interrupt(message.turnId);
      } else if (message.kind === 'shutdown') {
        // Der In-VM-Supervisor startet den Daemon frisch.
        this.daemonNeustarts += 1;
        this.session = this.neueSession();
      }
    });
    return true;
  }

  subscribe(_sandbox: string, listener: GatewayListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidate(): void {}

  closeGracefully(): void {
    this.melde({ kind: 'replaced' });
  }
}

async function aufbau(
  verhalten: Verhalten[],
  options: { prewarm?: boolean; firstEventMs?: number } = {},
) {
  const db = createTestDb();
  const owner = await createUser(db, 'marco');
  await db.insert(projects).values({
    id: 'p1',
    name: 'Projekt',
    branchName: 'marco/projekt',
    templateDir: 'pwa',
    devCommand: 'bun run dev',
    previewPort: 5173,
    ownerId: owner.id,
    agentModel: 'claude-sonnet-5-5',
  });
  const gateway = new SpeicherGateway(verhalten);
  const runner = new DaemonAgentRunner({
    gateway,
    sandboxNameFor: (projectId) => `sb-${projectId}`,
    connectTimeoutMs: 500,
    ackTimeoutMs: 500,
  });
  const service = new ChatService(
    db,
    runner,
    {},
    {
      prewarmEnabled: options.prewarm ?? false,
      timeouts: {
        firstEventMs: options.firstEventMs ?? 2_000,
        coldStartMs: options.firstEventMs ?? 2_000,
        idleMs: 5_000,
      },
      abortGraceMs: 30,
    },
  );
  const zeilen = async (): Promise<string[]> =>
    (await service.listMessages('p1')).map((m) => `${m.role}: ${m.content.slice(0, 60)}`);
  return { owner, gateway, service, zeilen };
}

const nachricht = (text: string) => ({ projectId: 'p1', text, workspaceDir: '/tmp/ws' });

describe('Host ↔ Daemon im selben Prozess (Paket 0 der Härtung 2026-11)', () => {
  test('Normalfall: ein Turn läuft durch', async () => {
    const t = await aufbau(['antwortet']);
    await t.service.sendMessage(t.owner, nachricht('hallo'));
    await waitFor(() => !t.service.isBusy('p1'), 3000);
    expect(await t.zeilen()).toEqual(['user: hallo', 'assistant: Antwort auf: hallo']);
    expect(t.gateway.daemonNeustarts).toBe(0);
  });

  test('A3: hängt die Query, gelingt der zweite Versuch auf einer frischen Query', async () => {
    // Vorher: der Abbruch des ersten Versuchs gab den Turn im Daemon nicht
    // frei (eine hängende Query liefert kein result). Der zweite Versuch wurde
    // abgewiesen und war der letzte — „Turn abgebrochen" ohne Zutun des Nutzers.
    const t = await aufbau(['stumm', 'antwortet'], { firstEventMs: 60 });
    await t.service.sendMessage(t.owner, nachricht('hallo'));
    await waitFor(() => !t.service.isBusy('p1'), 5000);

    const zeilen = await t.zeilen();
    expect(zeilen.at(-1)).toBe('assistant: Antwort auf: hallo');
    expect(zeilen.some((z) => z.startsWith('error'))).toBe(false);
    expect(t.gateway.queries).toHaveLength(2);
    // Kein turn-rejected, also kein angeforderter Daemon-Neustart.
    expect(t.gateway.daemonNeustarts).toBe(0);
  });

  test('A3: Stopp und sofort die nächste Nachricht — ohne Ablehnung, ohne Daemon-Neustart', async () => {
    const t = await aufbau(['langsam']);
    await t.service.sendMessage(t.owner, nachricht('zähle lange'));
    await waitFor(async () => (await t.zeilen()).some((z) => z.includes('ich arbeite noch')), 3000);

    await t.service.stopTurn(t.owner, 'p1');
    // Ohne jede Pause hinterher.
    await t.service.sendMessage(t.owner, nachricht('schnell bitte'));
    await waitFor(() => !t.service.isBusy('p1'), 5000);

    const zeilen = await t.zeilen();
    expect(zeilen.at(-1)).toBe('assistant: Antwort auf: schnell bitte');
    expect(zeilen.some((z) => z.includes('zweiter Versuch'))).toBe(false);
    expect(t.gateway.daemonNeustarts).toBe(0);
    // Dieselbe Query: die Sitzung hat den Abbruch überlebt.
    expect(t.gateway.queries).toHaveLength(1);
  });

  test('A2: Öffnen (Warmup) und sofort die erste Nachricht — der Turn wartet, niemand wird abgewiesen', async () => {
    const t = await aufbau(['antwortet'], { prewarm: true });
    // OHNE await dazwischen: der Warmup hängt noch in seiner DB-Abfrage.
    const warm = t.service.prewarm(t.owner, 'p1', '/tmp/ws');
    await t.service.sendMessage(t.owner, nachricht('erste Nachricht'));
    await warm;
    await waitFor(() => !t.service.isBusy('p1'), 5000);

    const zeilen = await t.zeilen();
    expect(zeilen).toEqual(['user: erste Nachricht', 'assistant: Antwort auf: erste Nachricht']);
    expect(t.gateway.daemonNeustarts).toBe(0);
    const starts = t.gateway.gesendet.filter((m) => m.kind === 'start-turn');
    expect(starts.length).toBeLessThanOrEqual(2);
  });

  test('zwei Nachrichten hintereinander werden nacheinander beantwortet', async () => {
    const t = await aufbau(['antwortet']);
    await t.service.sendMessage(t.owner, nachricht('eins'));
    await t.service.sendMessage(t.owner, nachricht('zwei'));
    await waitFor(() => !t.service.isBusy('p1'), 5000);
    const zeilen = await t.zeilen();
    expect(zeilen.filter((z) => z.startsWith('assistant'))).toEqual([
      'assistant: Antwort auf: eins',
      'assistant: Antwort auf: zwei',
    ]);
    expect(t.gateway.daemonNeustarts).toBe(0);
  });
});
