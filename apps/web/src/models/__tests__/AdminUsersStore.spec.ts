import { runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import { makeAuthStore, makeUser } from '../../__tests__/factories';
import { AdminUsersStore } from '../AdminUsersStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

const admin = makeUser({ id: 'u1', username: 'marco', role: 'admin' });
const pending = makeUser({ id: 'u2', username: 'gast', approved: false });

function makeStore(): AdminUsersStore {
  return new AdminUsersStore(makeAuthStore('marco', 'admin'));
}

describe('AdminUsersStore', () => {
  beforeEach(() => {
    mockGql.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('loadUsers lädt die Nutzerliste', async () => {
    mockGql.mockResolvedValueOnce({ users: [admin, pending] });
    const store = makeStore();

    await store.loadUsers();

    expect(store.users).toEqual([admin, pending]);
    expect(store.pendingUsers).toEqual([pending]);
    expect(store.error).toBeNull();
  });

  it('approveUser schaltet einen Nutzer frei und aktualisiert die Liste', async () => {
    mockGql.mockResolvedValueOnce({ users: [admin, pending] });
    const store = makeStore();
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
    const store = makeStore();
    await store.loadUsers();

    mockGql.mockResolvedValueOnce({ rejectUser: true });
    await store.rejectUser(pending.id);

    expect(store.users.find((u) => u.id === pending.id)).toBeUndefined();
    expect(mockGql).toHaveBeenLastCalledWith(expect.stringContaining('rejectUser'), {
      userId: pending.id,
    });
  });

  describe('Fehler bleiben in DIESEM Store (früher landeten sie unsichtbar im AuthStore)', () => {
    it('ein Fehlschlag steht in error und lässt den AuthStore unberührt', async () => {
      const authStore = makeAuthStore('marco', 'admin');
      const store = new AdminUsersStore(authStore);
      mockGql.mockRejectedValueOnce(new Error('Nur Admins dürfen das'));

      await store.approveUser('u2');

      expect(store.error).toBe('Nur Admins dürfen das');
      expect(authStore.error).toBeNull();
    });

    it('die nächste erfolgreiche Aktion räumt den alten Fehler weg', async () => {
      const store = makeStore();
      mockGql.mockRejectedValueOnce(new Error('Netz weg'));
      await store.loadUsers();
      expect(store.error).toBe('Netz weg');

      mockGql.mockResolvedValueOnce({ users: [admin] });
      await store.loadUsers();

      expect(store.error).toBeNull();
    });
  });

  it('leert Liste und Fehler beim Abmelden (kein Nutzerverzeichnis für den nächsten Login)', async () => {
    const authStore = makeAuthStore('marco', 'admin');
    const store = new AdminUsersStore(authStore);
    mockGql.mockResolvedValueOnce({ users: [admin, pending] });
    await store.loadUsers();

    runInAction(() => {
      authStore.currentUser = null;
    });

    expect(store.users).toEqual([]);
    expect(store.error).toBeNull();
  });
});
