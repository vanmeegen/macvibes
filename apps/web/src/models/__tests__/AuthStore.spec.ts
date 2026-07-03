import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import type { User } from '../../api/types';
import { AuthStore } from '../AuthStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

const alice: User = { id: 'u1', username: 'alice' };

describe('AuthStore', () => {
  beforeEach(() => {
    mockGql.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  describe('loadMe', () => {
    it('setzt currentUser und initialized bei Erfolg', async () => {
      mockGql.mockResolvedValueOnce({ me: alice });
      const store = new AuthStore();

      await store.loadMe();

      expect(store.currentUser).toEqual(alice);
      expect(store.initialized).toBe(true);
      expect(store.error).toBeNull();
      expect(store.pending).toBe(false);
    });

    it('lässt currentUser null, wenn me null liefert (nicht angemeldet)', async () => {
      mockGql.mockResolvedValueOnce({ me: null });
      const store = new AuthStore();

      await store.loadMe();

      expect(store.currentUser).toBeNull();
      expect(store.initialized).toBe(true);
      expect(store.error).toBeNull();
    });

    it('speichert den Fehler und setzt initialized trotzdem', async () => {
      mockGql.mockRejectedValueOnce(new Error('Server nicht erreichbar'));
      const store = new AuthStore();

      await store.loadMe();

      expect(store.currentUser).toBeNull();
      expect(store.initialized).toBe(true);
      expect(store.error).toBe('Server nicht erreichbar');
    });
  });

  describe('login', () => {
    it('setzt currentUser bei Erfolg und liefert true', async () => {
      mockGql.mockResolvedValueOnce({ login: alice });
      const store = new AuthStore();

      const ok = await store.login('alice', 'geheim');

      expect(ok).toBe(true);
      expect(store.currentUser).toEqual(alice);
      expect(store.error).toBeNull();
      expect(store.pending).toBe(false);
      expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('login'), {
        username: 'alice',
        password: 'geheim',
      });
    });

    it('speichert die Fehlermeldung bei Misserfolg und liefert false', async () => {
      mockGql.mockRejectedValueOnce(new Error('Benutzername oder Passwort falsch'));
      const store = new AuthStore();

      const ok = await store.login('alice', 'falsch');

      expect(ok).toBe(false);
      expect(store.currentUser).toBeNull();
      expect(store.error).toBe('Benutzername oder Passwort falsch');
      expect(store.pending).toBe(false);
    });
  });

  describe('register', () => {
    it('setzt currentUser bei Erfolg', async () => {
      mockGql.mockResolvedValueOnce({ register: alice });
      const store = new AuthStore();

      const ok = await store.register('alice', 'geheim', 'invite-123');

      expect(ok).toBe(true);
      expect(store.currentUser).toEqual(alice);
      expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('register'), {
        username: 'alice',
        password: 'geheim',
        inviteCode: 'invite-123',
      });
    });

    it('speichert die Fehlermeldung bei ungültigem Invite-Code', async () => {
      mockGql.mockRejectedValueOnce(new Error('Ungültiger Invite-Code'));
      const store = new AuthStore();

      const ok = await store.register('alice', 'geheim', 'nope');

      expect(ok).toBe(false);
      expect(store.currentUser).toBeNull();
      expect(store.error).toBe('Ungültiger Invite-Code');
    });
  });

  describe('logout', () => {
    it('entfernt currentUser bei Erfolg', async () => {
      mockGql.mockResolvedValueOnce({ login: alice });
      const store = new AuthStore();
      await store.login('alice', 'geheim');

      mockGql.mockResolvedValueOnce({ logout: true });
      await store.logout();

      expect(store.currentUser).toBeNull();
      expect(store.error).toBeNull();
    });

    it('speichert die Fehlermeldung, wenn logout fehlschlägt', async () => {
      mockGql.mockResolvedValueOnce({ login: alice });
      const store = new AuthStore();
      await store.login('alice', 'geheim');

      mockGql.mockRejectedValueOnce(new Error('Abmeldung fehlgeschlagen'));
      await store.logout();

      expect(store.currentUser).toEqual(alice);
      expect(store.error).toBe('Abmeldung fehlgeschlagen');
    });
  });
});
