import { makeAutoObservable, runInAction } from 'mobx';
import { toErrorMessage } from '../api/errors';
import { gqlRequest } from '../api/graphqlClient';
import type { User } from '../api/types';

export const USER_FIELDS = /* GraphQL */ `
  id
  username
  role
  approved
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
  mutation Register($username: String!, $password: String!, $bootstrapToken: String) {
    register(username: $username, password: $password, bootstrapToken: $bootstrapToken) { ${USER_FIELDS} }
  }
`;

const LOGOUT_MUTATION = /* GraphQL */ `
  mutation Logout {
    logout
  }
`;

const PENDING_NOTICE =
  'Registrierung eingegangen. Ein Admin muss dein Konto freischalten, danach kannst du dich anmelden.';

/** Ergebnis einer Registrierung aus Sicht des UI. */
type RegisterOutcome = 'loggedIn' | 'pending' | 'failed';

/**
 * Authentifizierungs-Store: hält den aktuell angemeldeten Benutzer. Die
 * Session lebt in einem httpOnly-Cookie, das der Server setzt. (Die
 * Admin-Nutzerverwaltung liegt im AdminUsersStore.)
 */
export class AuthStore {
  currentUser: User | null = null;
  /** true, sobald loadMe() einmal durchgelaufen ist (erfolgreich oder nicht). */
  initialized = false;
  error: string | null = null;
  /** Positiver Hinweis (z. B. „warte auf Freischaltung"). */
  notice: string | null = null;
  pending = false;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  get isAdmin(): boolean {
    return this.currentUser?.role === 'admin';
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
   * Selbst-Registrierung ohne Invite-Code. Der Bootstrap-Admin wird sofort
   * eingeloggt; alle weiteren landen im pending-Zustand und müssen
   * freigeschaltet werden. `bootstrapToken` braucht NUR die Erst-Registrierung
   * des Admins auf einer Instanz mit gesetztem MACVIBES_ADMIN_BOOTSTRAP_TOKEN;
   * ohne Angabe wird die Variable weggelassen (Normalfall aller Nutzer).
   */
  async register(
    username: string,
    password: string,
    bootstrapToken?: string,
  ): Promise<RegisterOutcome> {
    this.pending = true;
    this.error = null;
    this.notice = null;
    try {
      // Nur mitschicken, wenn wirklich angegeben — der Server behandelt eine
      // fehlende Variable wie null, und die Alt-Aufrufer bleiben unverändert.
      const variables: Record<string, unknown> =
        bootstrapToken === undefined || bootstrapToken === ''
          ? { username, password }
          : { username, password, bootstrapToken };
      const data = await gqlRequest<{ register: User }>(REGISTER_MUTATION, variables);
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
