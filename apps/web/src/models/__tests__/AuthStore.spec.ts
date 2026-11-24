import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import { makeUser } from '../../__tests__/factories';
import { AuthStore } from '../AuthStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

const admin = makeUser({ id: 'u1', username: 'marco', role: 'admin' });
const pending = makeUser({ id: 'u2', username: 'gast', approved: false });

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

    it('sendet den Bootstrap-Token mit, wenn er angegeben wurde (Erst-Admin)', async () => {
      // Neue Installationen schützen den Admin-Namen mit
      // MACVIBES_ADMIN_BOOTSTRAP_TOKEN — die Erst-Registrierung muss ihn
      // mitschicken können, sonst weist der Server sie ab.
      mockGql.mockResolvedValueOnce({ register: admin });
      const store = new AuthStore();

      const outcome = await store.register('marco', 'geheim', 'boot-tok-123');

      expect(outcome).toBe('loggedIn');
      expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('register'), {
        username: 'marco',
        password: 'geheim',
        bootstrapToken: 'boot-tok-123',
      });
    });

    it('lässt einen LEEREN Bootstrap-Token weg (leeres Formularfeld)', async () => {
      mockGql.mockResolvedValueOnce({ register: pending });
      const store = new AuthStore();

      await store.register('gast', 'geheim', '');

      expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('register'), {
        username: 'gast',
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

    it('meldet einen Fehlschlag in error — die Projektübersicht zeigt ihn an', async () => {
      mockGql.mockResolvedValueOnce({ login: admin });
      const store = new AuthStore();
      await store.login('marco', 'geheim');

      mockGql.mockRejectedValueOnce(new Error('Netz weg'));
      await store.logout();

      expect(store.currentUser).toEqual(admin);
      expect(store.error).toBe('Netz weg');
    });
  });
});
