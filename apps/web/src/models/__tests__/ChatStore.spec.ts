import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../api/types';
import { ChatStore } from '../ChatStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

import { gqlRequest } from '../../api/graphqlClient';

const gqlRequestMock = vi.mocked(gqlRequest);

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  projectId = 'p1',
): ChatMessage {
  return {
    id,
    projectId,
    turnId: 't1',
    role,
    content,
    createdAt: '2026-07-03T12:00:00.000Z',
  };
}

/** Kontrollierbarer EventSource-Ersatz — zeichnet Instanzen und close() auf. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  onerror: ((err: unknown) => void) | null = null;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(): void {}

  close(): void {
    this.closed = true;
  }

  static open(): FakeEventSource[] {
    return FakeEventSource.instances.filter((es) => !es.closed);
  }
}

describe('ChatStore', () => {
  beforeEach(() => {
    gqlRequestMock.mockReset();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  describe('applyEvent', () => {
    it('hängt neue Nachrichten an und übernimmt turnActive', () => {
      const store = new ChatStore();
      store.projectId = 'p1';
      store.applyEvent({ message: message('m1', 'user', 'Hallo'), turnActive: true });
      expect(store.messages).toHaveLength(1);
      expect(store.turnActive).toBe(true);
    });

    it('ersetzt bestehende Nachrichten anhand der ID (Streaming-Deltas)', () => {
      const store = new ChatStore();
      store.projectId = 'p1';
      store.applyEvent({ message: message('m1', 'assistant', 'Ec'), turnActive: true });
      store.applyEvent({ message: message('m1', 'assistant', 'Echo: Hallo'), turnActive: false });
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]?.content).toBe('Echo: Hallo');
      expect(store.turnActive).toBe(false);
    });

    it('ignoriert Events fremder Projekte (Projekt-Trennung)', () => {
      const store = new ChatStore();
      store.projectId = 'p1';
      store.applyEvent({
        message: message('fremd-1', 'assistant', 'anderes Projekt', 'p2'),
        turnActive: true,
      });
      expect(store.messages).toHaveLength(0);
      expect(store.turnActive).toBe(false);
    });
  });

  describe('connect — saubere Projekt-Trennung (Race beim Projektwechsel)', () => {
    it('eine verspätete History-Antwort eines alten connect() überschreibt das neue Projekt nicht', async () => {
      // Projekt A: History-Query hängt (Server langsam).
      let resolveA: (v: unknown) => void = () => {};
      gqlRequestMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      );
      const store = new ChatStore();
      const connectA = store.connect('projekt-a');

      // Nutzer wechselt zu Projekt B — dessen History kommt sofort.
      gqlRequestMock.mockResolvedValueOnce({
        chatMessages: [message('b-1', 'assistant', 'Hallo aus B', 'projekt-b')],
        turnActive: false,
      });
      await store.connect('projekt-b');

      // Jetzt trudelt As Antwort ein — sie darf B nicht überschreiben.
      resolveA({
        chatMessages: [message('a-1', 'assistant', 'Hallo aus A', 'projekt-a')],
        turnActive: true,
      });
      await connectA;

      expect(store.projectId).toBe('projekt-b');
      expect(store.messages.map((m) => m.id)).toEqual(['b-1']);
      expect(store.turnActive).toBe(false);
    });

    it('ein veralteter connect() hinterlässt keine offene EventSource (SSE-Leak)', async () => {
      let resolveA: (v: unknown) => void = () => {};
      gqlRequestMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      );
      const store = new ChatStore();
      const connectA = store.connect('projekt-a');

      gqlRequestMock.mockResolvedValueOnce({ chatMessages: [], turnActive: false });
      await store.connect('projekt-b');

      resolveA({ chatMessages: [], turnActive: false });
      await connectA;

      // Genau EINE offene Verbindung — die von Projekt B.
      const open = FakeEventSource.open();
      expect(open).toHaveLength(1);
      expect(open[0]?.url).toContain('projekt-b');
    });

    it('disconnect() entwertet einen laufenden connect() (StrictMode-Doppelmount)', async () => {
      let resolveA: (v: unknown) => void = () => {};
      gqlRequestMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      );
      const store = new ChatStore();
      const connectA = store.connect('projekt-a');
      store.disconnect();

      resolveA({
        chatMessages: [message('a-1', 'assistant', 'Hallo aus A', 'projekt-a')],
        turnActive: true,
      });
      await connectA;

      expect(store.messages).toHaveLength(0);
      expect(store.turnActive).toBe(false);
      expect(FakeEventSource.open()).toHaveLength(0);
    });
  });

  describe('send — sofortiges Feedback (Chat-UX)', () => {
    it('zeigt die eigene Nachricht SOFORT als Bubble, ohne auf den Server zu warten', async () => {
      // Mutation hängt (Server langsam) — die Bubble muss trotzdem sofort da sein.
      let resolveSend: (v: unknown) => void = () => {};
      gqlRequestMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSend = resolve;
          }),
      );
      const store = new ChatStore();
      store.projectId = 'p1';
      store.setDraft('Bau mir was');

      const sending = store.send();
      // Noch KEIN Server-Roundtrip abgeschlossen:
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]?.role).toBe('user');
      expect(store.messages[0]?.content).toBe('Bau mir was');
      // Und der Turn gilt sofort als aktiv („Agent arbeitet"-Feedback).
      expect(store.turnActive).toBe(true);

      resolveSend({ sendMessage: true });
      await sending;
    });

    it('ersetzt die optimistische Bubble durch das Server-Event ohne Duplikat', async () => {
      gqlRequestMock.mockResolvedValue({ sendMessage: true });
      const store = new ChatStore();
      store.projectId = 'p1';
      store.setDraft('Hallo Agent');
      await store.send();
      expect(store.messages).toHaveLength(1);

      // Server broadcastet die persistierte User-Nachricht (echte ID).
      store.applyEvent({ message: message('srv-1', 'user', 'Hallo Agent'), turnActive: true });

      const userMessages = store.messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.id).toBe('srv-1');
    });

    it('entfernt die optimistische Bubble und stellt den Entwurf wieder her, wenn das Senden scheitert', async () => {
      gqlRequestMock.mockRejectedValue(new Error('Netz weg'));
      const store = new ChatStore();
      store.projectId = 'p1';
      store.setDraft('Wichtig');
      await store.send();

      expect(store.messages.filter((m) => m.role === 'user')).toHaveLength(0);
      expect(store.draft).toBe('Wichtig');
      expect(store.turnActive).toBe(false);
    });
  });

  describe('send', () => {
    it('sendet den Entwurf als Mutation und leert das Eingabefeld', async () => {
      gqlRequestMock.mockResolvedValue({ sendMessage: true });
      const store = new ChatStore();
      store.projectId = 'p1';
      store.setDraft('  Hallo Agent  ');

      await store.send();

      expect(gqlRequestMock).toHaveBeenCalledTimes(1);
      const [, variables] = gqlRequestMock.mock.calls[0] ?? [];
      expect(variables).toEqual({ projectId: 'p1', text: 'Hallo Agent', interrupt: false });
      expect(store.draft).toBe('');
      expect(store.error).toBeNull();
    });

    it('setzt interrupt=true, wenn schon ein Turn läuft (Mid-Turn-Steering)', async () => {
      gqlRequestMock.mockResolvedValue({ sendMessage: true });
      const store = new ChatStore();
      store.projectId = 'p1';
      store.turnActive = true;
      store.setDraft('Neue Anweisung');

      await store.send();

      const [, variables] = gqlRequestMock.mock.calls[0] ?? [];
      expect(variables).toMatchObject({ interrupt: true });
    });

    it('ignoriert leere Entwürfe', async () => {
      const store = new ChatStore();
      store.projectId = 'p1';
      store.setDraft('   ');
      await store.send();
      expect(gqlRequestMock).not.toHaveBeenCalled();
    });

    it('zeigt Fehler an und stellt den Entwurf wieder her', async () => {
      gqlRequestMock.mockRejectedValue(
        new Error('Nur der Eigentümer kann mit diesem Projekt arbeiten'),
      );
      const store = new ChatStore();
      store.projectId = 'p1';
      store.setDraft('Hallo');

      await store.send();

      expect(store.error).toContain('Eigentümer');
      expect(store.draft).toBe('Hallo');
    });
  });

  describe('reconcile — Sicherheitsnetz gegen verpasstes Turn-Ende', () => {
    it('setzt turnActive auf false, wenn der Server keinen aktiven Turn meldet', async () => {
      gqlRequestMock.mockResolvedValue({ turnActive: false });
      const store = new ChatStore();
      store.projectId = 'p1';
      store.turnActive = true; // SSE-Endevent verpasst

      await store.reconcileTurnActive();

      expect(store.turnActive).toBe(false);
    });

    it('lässt turnActive true, solange der Server den Turn noch als aktiv meldet', async () => {
      gqlRequestMock.mockResolvedValue({ turnActive: true });
      const store = new ChatStore();
      store.projectId = 'p1';
      store.turnActive = true;

      await store.reconcileTurnActive();

      expect(store.turnActive).toBe(true);
    });
  });

  describe('stop', () => {
    it('ruft die stopTurn-Mutation auf', async () => {
      gqlRequestMock.mockResolvedValue({ stopTurn: true });
      const store = new ChatStore();
      store.projectId = 'p1';
      await store.stop();
      expect(gqlRequestMock).toHaveBeenCalledTimes(1);
      const [, variables] = gqlRequestMock.mock.calls[0] ?? [];
      expect(variables).toEqual({ projectId: 'p1' });
    });
  });
});

describe('Chat ausblendbar (Preview im Vollbild)', () => {
  it('chatCollapsed startet sichtbar und lässt sich togglen', () => {
    const store = new ChatStore();
    expect(store.chatCollapsed).toBe(false);
    store.toggleChatCollapsed();
    expect(store.chatCollapsed).toBe(true);
    store.toggleChatCollapsed();
    expect(store.chatCollapsed).toBe(false);
  });

  it('connect() eines Projekts blendet den Chat wieder ein (kein versteckter Chat beim Projektwechsel)', async () => {
    const store = new ChatStore();
    store.toggleChatCollapsed();
    expect(store.chatCollapsed).toBe(true);
    gqlRequestMock.mockResolvedValueOnce({ chatMessages: [], turnActive: false });
    // jsdom hat kein EventSource — minimaler Stub reicht für connect().
    vi.stubGlobal(
      'EventSource',
      class {
        addEventListener(): void {}
        close(): void {}
        onerror: unknown = null;
      },
    );
    await store.connect('p1');
    vi.unstubAllGlobals();
    expect(store.chatCollapsed).toBe(false);
  });
});
