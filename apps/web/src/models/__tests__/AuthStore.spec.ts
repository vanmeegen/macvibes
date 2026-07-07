import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import type { User } from '../../api/types';
import { AuthStore } from '../AuthStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

const admin: User = { id: 'u1', username: 'marco', role: 'admin', approved: true, createdAt: 't0' };
const pending: User = {
  id: 'u2',
  username: 'gast',
  role: 'user',
  approved: false,
  createdAt: 't1',
};

describe('AuthStore', () => {
  beforeEach(() => {
    mockGql.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  describe('loadMe', () => {
    it('setzt currentUser und initialized bei Erfolg', async () => {
      mockGql.mockResolvedValueOnce({ me: admin });
      const store = new AuthStore();

      await store.loadMe();

      expect(store.currentUser).toEqual(admin);
      expect(store.isAdmin).toBe(true);
      expect(store.initialized).toBe(true);
      expect(store.error).toBeNull();
      expect(store.pending).toBe(false);
    });

    it('lässt currentUser null, wenn me null liefert (nicht angemeldet)', async () => {
      mockGql.mockResolvedValueOnce({ me: null });
      const store = new AuthStore();

      await store.loadMe();

      expect(store.currentUser).toBeNull();
      expect(store.isAdmin).toBe(false);
      expect(store.initialized).toBe(true);
    });
  });

  describe('login', () => {
    it('setzt currentUser bei Erfolg und liefert true', async () => {
      mockGql.mockResolvedValueOnce({ login: admin });
      const store = new AuthStore();

      const ok = await store.login('marco', 'geheim');

      expect(ok).toBe(true);
      expect(store.currentUser).toEqual(admin);
      expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('login'), {
        username: 'marco',
        password: 'geheim',
      });
    });

    it('speichert die Fehlermeldung bei Misserfolg und liefert false', async () => {
      mockGql.mockRejectedValueOnce(new Error('Benutzername oder Passwort falsch'));
      const store = new AuthStore();

      const ok = await store.login('marco', 'falsch');

      expect(ok).toBe(false);
      expect(store.currentUser).toBeNull();
      expect(store.error).toBe('Benutzername oder Passwort falsch');
    });
  });

  describe('register (Self-Registration)', () => {
    it('erster/freigeschalteter User: loggedIn, currentUser gesetzt, kein Invite-Code', async () => {
      mockGql.mockResolvedValueOnce({ register: admin });
      const store = new AuthStore();

      const outcome = await store.register('marco', 'geheim');

      expect(outcome).toBe('loggedIn');
      expect(store.currentUser).toEqual(admin);
      expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('register'), {
        username: 'marco',
        password: 'geheim',
      });
    });

    it('weiterer User: pending, kein Login, Hinweistext gesetzt', async () => {
      mockGql.mockResolvedValueOnce({ register: pending });
      const store = new AuthStore();

      const outcome = await store.register('gast', 'geheim');

      expect(outcome).toBe('pending');
      expect(store.currentUser).toBeNull();
      expect(store.notice).toMatch(/freischalt/i);
    });

    it('speichert die Fehlermeldung bei Misserfolg', async () => {
      mockGql.mockRejectedValueOnce(new Error('Benutzername ist bereits vergeben'));
      const store = new AuthStore();

      const outcome = await store.register('marco', 'geheim');

      expect(outcome).toBe('failed');
      expect(store.currentUser).toBeNull();
      expect(store.error).toBe('Benutzername ist bereits vergeben');
    });
  });

  describe('Admin: Nutzerverwaltung', () => {
    it('loadUsers lädt die Nutzerliste', async () => {
      mockGql.mockResolvedValueOnce({ users: [admin, pending] });
      const store = new AuthStore();

      await store.loadUsers();

      expect(store.users).toEqual([admin, pending]);
      expect(store.pendingUsers).toEqual([pending]);
    });

    it('approveUser schaltet einen Nutzer frei und aktualisiert die Liste', async () => {
      mockGql.mockResolvedValueOnce({ users: [admin, pending] });
      const store = new AuthStore();
      await store.loadUsers();

      mockGql.mockResolvedValueOnce({ approveUser: { ...pending, approved: true } });
      await store.approveUser(pending.id);

      expect(store.users.find((u) => u.id === pending.id)?.approved).toBe(true);
      expect(store.pendingUsers).toEqual([]);
      expect(mockGql).toHaveBeenLastCalledWith(expect.stringContaining('approveUser'), {
        userId: pending.id,
      });
    });

    it('rejectUser entfernt den Nutzer aus der Liste', async () => {
      mockGql.mockResolvedValueOnce({ users: [admin, pending] });
      const store = new AuthStore();
      await store.loadUsers();

      mockGql.mockResolvedValueOnce({ rejectUser: true });
      await store.rejectUser(pending.id);

      expect(store.users.find((u) => u.id === pending.id)).toBeUndefined();
      expect(mockGql).toHaveBeenLastCalledWith(expect.stringContaining('rejectUser'), {
        userId: pending.id,
      });
    });
  });

  describe('logout', () => {
    it('entfernt currentUser bei Erfolg', async () => {
      mockGql.mockResolvedValueOnce({ login: admin });
      const store = new AuthStore();
      await store.login('marco', 'geheim');

      mockGql.mockResolvedValueOnce({ logout: true });
      await store.logout();

      expect(store.currentUser).toBeNull();
      expect(store.error).toBeNull();
    });
  });
});
