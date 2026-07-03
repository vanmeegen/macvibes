import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../api/types';
import { ChatStore } from '../ChatStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

import { gqlRequest } from '../../api/graphqlClient';

const gqlRequestMock = vi.mocked(gqlRequest);

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id,
    projectId: 'p1',
    turnId: 't1',
    role,
    content,
    createdAt: '2026-07-03T12:00:00.000Z',
  };
}

describe('ChatStore', () => {
  beforeEach(() => {
    gqlRequestMock.mockReset();
  });

  describe('applyEvent', () => {
    it('hängt neue Nachrichten an und übernimmt turnActive', () => {
      const store = new ChatStore();
      store.applyEvent({ message: message('m1', 'user', 'Hallo'), turnActive: true });
      expect(store.messages).toHaveLength(1);
      expect(store.turnActive).toBe(true);
    });

    it('ersetzt bestehende Nachrichten anhand der ID (Streaming-Deltas)', () => {
      const store = new ChatStore();
      store.applyEvent({ message: message('m1', 'assistant', 'Ec'), turnActive: true });
      store.applyEvent({ message: message('m1', 'assistant', 'Echo: Hallo'), turnActive: false });
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0]?.content).toBe('Echo: Hallo');
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
      expect(variables).toEqual({ projectId: 'p1', text: 'Hallo Agent' });
      expect(store.draft).toBe('');
      expect(store.error).toBeNull();
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
