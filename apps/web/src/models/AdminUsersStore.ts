import { makeAutoObservable, reaction, runInAction } from 'mobx';
import { toErrorMessage } from '../api/errors';
import { gqlRequest } from '../api/graphqlClient';
import type { User } from '../api/types';
import { USER_FIELDS, type AuthStore } from './AuthStore';

const USERS_QUERY = /* GraphQL */ `
  query Users {
    users { ${USER_FIELDS} }
  }
`;

const APPROVE_USER_MUTATION = /* GraphQL */ `
  mutation ApproveUser($userId: ID!) {
    approveUser(userId: $userId) { ${USER_FIELDS} }
  }
`;

const REJECT_USER_MUTATION = /* GraphQL */ `
  mutation RejectUser($userId: ID!) {
    rejectUser(userId: $userId)
  }
`;

/**
 * Admin-Nutzerverwaltung: Nutzerliste, Freischalten, Ablehnen. Eigener Store
 * mit eigenem Fehlerfeld, das die Admin-Seite anzeigt — im AuthStore wären die
 * Fehler nur auf der Login-Seite sichtbar geworden.
 */
export class AdminUsersStore {
  users: User[] = [];
  error: string | null = null;

  constructor(authStore: AuthStore) {
    makeAutoObservable(this, {}, { autoBind: true });
    // Abmelden leert die Liste: das Nutzerverzeichnis darf nicht für den
    // nächsten Login im Speicher liegen bleiben.
    reaction(
      () => authStore.currentUser === null,
      (loggedOut) => {
        if (loggedOut) this.reset();
      },
    );
  }

  /** Noch nicht freigeschaltete Registrierungen. */
  get pendingUsers(): User[] {
    return this.users.filter((u) => !u.approved);
  }

  reset(): void {
    this.users = [];
    this.error = null;
  }

  clearError(): void {
    this.error = null;
  }

  async loadUsers(): Promise<void> {
    await this.run('loadUsers', async () => {
      const data = await gqlRequest<{ users: User[] }>(USERS_QUERY);
      runInAction(() => {
        this.users = data.users;
      });
    });
  }

  async approveUser(userId: string): Promise<void> {
    await this.run('approveUser', async () => {
      const data = await gqlRequest<{ approveUser: User }>(APPROVE_USER_MUTATION, { userId });
      runInAction(() => {
        this.users = this.users.map((u) => (u.id === userId ? data.approveUser : u));
      });
    });
  }

  /** Registrierung ablehnen bzw. Nutzer entfernen. */
  async rejectUser(userId: string): Promise<void> {
    await this.run('rejectUser', async () => {
      await gqlRequest<{ rejectUser: boolean }>(REJECT_USER_MUTATION, { userId });
      runInAction(() => {
        this.users = this.users.filter((u) => u.id !== userId);
      });
    });
  }

  /** Führt eine Aktion aus; ein Fehlschlag wird geloggt und in `error` gezeigt. */
  private async run(label: string, action: () => Promise<void>): Promise<void> {
    this.error = null;
    try {
      await action();
    } catch (err) {
      console.error(`AdminUsersStore.${label} fehlgeschlagen`, err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    }
  }
}
