import { makeAutoObservable, runInAction } from 'mobx';
import { gqlRequest } from '../api/graphqlClient';
import type { User } from '../api/types';

const USER_FIELDS = /* GraphQL */ `
  id
  username
  role
  approved
  createdAt
`;

const ME_QUERY = /* GraphQL */ `
  query Me {
    me { ${USER_FIELDS} }
  }
`;

const LOGIN_MUTATION = /* GraphQL */ `
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) { ${USER_FIELDS} }
  }
`;

const REGISTER_MUTATION = /* GraphQL */ `
  mutation Register($username: String!, $password: String!) {
    register(username: $username, password: $password) { ${USER_FIELDS} }
  }
`;

const LOGOUT_MUTATION = /* GraphQL */ `
  mutation Logout {
    logout
  }
`;

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

const PENDING_NOTICE =
  'Registrierung eingegangen. Ein Admin muss dein Konto freischalten, danach kannst du dich anmelden.';

/** Ergebnis einer Registrierung aus Sicht des UI. */
export type RegisterOutcome = 'loggedIn' | 'pending' | 'failed';

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Authentifizierungs-Store: hält den aktuell angemeldeten Benutzer sowie
 * (für Admins) die Nutzerverwaltung. Die Session lebt in einem httpOnly-Cookie,
 * das der Server setzt.
 */
export class AuthStore {
  currentUser: User | null = null;
  /** true, sobald loadMe() einmal durchgelaufen ist (erfolgreich oder nicht). */
  initialized = false;
  error: string | null = null;
  /** Positiver Hinweis (z. B. „warte auf Freischaltung"). */
  notice: string | null = null;
  pending = false;
  /** Admin-Nutzerverwaltung. */
  users: User[] = [];

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get isAdmin(): boolean {
    return this.currentUser?.role === 'admin';
  }

  /** Noch nicht freigeschaltete Registrierungen — für das Admin-Panel. */
  get pendingUsers(): User[] {
    return this.users.filter((u) => !u.approved);
  }

  /** Lädt den aktuellen Benutzer (me); null = nicht angemeldet. */
  async loadMe(): Promise<void> {
    this.pending = true;
    try {
      const data = await gqlRequest<{ me: User | null }>(ME_QUERY);
      runInAction(() => {
        this.currentUser = data.me;
        this.error = null;
      });
    } catch (err) {
      console.error('AuthStore.loadMe fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    } finally {
      runInAction(() => {
        this.pending = false;
        this.initialized = true;
      });
    }
  }

  async login(username: string, password: string): Promise<boolean> {
    this.pending = true;
    this.error = null;
    this.notice = null;
    try {
      const data = await gqlRequest<{ login: User }>(LOGIN_MUTATION, { username, password });
      runInAction(() => {
        this.currentUser = data.login;
      });
      return true;
    } catch (err) {
      console.error('AuthStore.login fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
      return false;
    } finally {
      runInAction(() => {
        this.pending = false;
      });
    }
  }

  /**
   * Selbst-Registrierung ohne Invite-Code. Der erste Nutzer wird sofort
   * eingeloggt (Admin); alle weiteren landen im pending-Zustand und müssen
   * freigeschaltet werden.
   */
  async register(username: string, password: string): Promise<RegisterOutcome> {
    this.pending = true;
    this.error = null;
    this.notice = null;
    try {
      const data = await gqlRequest<{ register: User }>(REGISTER_MUTATION, { username, password });
      if (data.register.approved) {
        runInAction(() => {
          this.currentUser = data.register;
        });
        return 'loggedIn';
      }
      runInAction(() => {
        this.notice = PENDING_NOTICE;
      });
      return 'pending';
    } catch (err) {
      console.error('AuthStore.register fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
      return 'failed';
    } finally {
      runInAction(() => {
        this.pending = false;
      });
    }
  }

  async logout(): Promise<void> {
    this.pending = true;
    this.error = null;
    try {
      await gqlRequest<{ logout: boolean }>(LOGOUT_MUTATION);
      runInAction(() => {
        this.currentUser = null;
        this.users = [];
      });
    } catch (err) {
      console.error('AuthStore.logout fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    } finally {
      runInAction(() => {
        this.pending = false;
      });
    }
  }

  /** Admin: alle Nutzer laden. */
  async loadUsers(): Promise<void> {
    try {
      const data = await gqlRequest<{ users: User[] }>(USERS_QUERY);
      runInAction(() => {
        this.users = data.users;
      });
    } catch (err) {
      console.error('AuthStore.loadUsers fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    }
  }

  /** Admin: Nutzer freischalten. */
  async approveUser(userId: string): Promise<void> {
    try {
      const data = await gqlRequest<{ approveUser: User }>(APPROVE_USER_MUTATION, { userId });
      runInAction(() => {
        this.users = this.users.map((u) => (u.id === userId ? data.approveUser : u));
      });
    } catch (err) {
      console.error('AuthStore.approveUser fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    }
  }

  /** Admin: Registrierung ablehnen (Nutzer entfernen). */
  async rejectUser(userId: string): Promise<void> {
    try {
      await gqlRequest<{ rejectUser: boolean }>(REJECT_USER_MUTATION, { userId });
      runInAction(() => {
        this.users = this.users.filter((u) => u.id !== userId);
      });
    } catch (err) {
      console.error('AuthStore.rejectUser fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    }
  }

  clearError(): void {
    this.error = null;
  }
}
