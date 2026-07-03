import { makeAutoObservable, runInAction } from 'mobx';
import { gqlRequest } from '../api/graphqlClient';
import type { User } from '../api/types';

const ME_QUERY = /* GraphQL */ `
  query Me {
    me {
      id
      username
    }
  }
`;

const LOGIN_MUTATION = /* GraphQL */ `
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      id
      username
    }
  }
`;

const REGISTER_MUTATION = /* GraphQL */ `
  mutation Register($username: String!, $password: String!, $inviteCode: String!) {
    register(username: $username, password: $password, inviteCode: $inviteCode) {
      id
      username
    }
  }
`;

const LOGOUT_MUTATION = /* GraphQL */ `
  mutation Logout {
    logout
  }
`;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Authentifizierungs-Store: hält den aktuell angemeldeten Benutzer.
 * Die Session lebt in einem httpOnly-Cookie, das der Server setzt.
 */
export class AuthStore {
  currentUser: User | null = null;
  /** true, sobald loadMe() einmal durchgelaufen ist (erfolgreich oder nicht). */
  initialized = false;
  error: string | null = null;
  pending = false;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
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

  async register(username: string, password: string, inviteCode: string): Promise<boolean> {
    this.pending = true;
    this.error = null;
    try {
      const data = await gqlRequest<{ register: User }>(REGISTER_MUTATION, {
        username,
        password,
        inviteCode,
      });
      runInAction(() => {
        this.currentUser = data.register;
      });
      return true;
    } catch (err) {
      console.error('AuthStore.register fehlgeschlagen', err);
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

  async logout(): Promise<void> {
    this.pending = true;
    this.error = null;
    try {
      await gqlRequest<{ logout: boolean }>(LOGOUT_MUTATION);
      runInAction(() => {
        this.currentUser = null;
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

  clearError(): void {
    this.error = null;
  }
}
