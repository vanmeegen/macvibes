import { runInAction } from 'mobx';
import type { Project, Template, User, UserRole } from '../api/types';
import { AuthStore } from '../models/AuthStore';

/** Gemeinsame Test-Fixtures der Unit-Specs — eine Quelle statt Kopien je Spec. */

export function makeUser(overrides: Partial<User> = {}): User {
  return { id: 'u1', username: 'alice', role: 'user', approved: true, ...overrides };
}

export function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    name: `Projekt ${overrides.id}`,
    templateDir: 'react-starter',
    owner: makeUser({ role: 'admin' }),
    agentModel: 'claude-sonnet-5-5',
    lastActivityAt: '2026-07-02T12:00:00.000Z',
    sandboxStatus: 'stopped',
    previewStatus: 'stopped',
    turnActive: false,
    ...overrides,
  };
}

export function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    name: 'React Starter',
    description: 'Vite + React Grundgerüst',
    dir: 'react-starter',
    ...overrides,
  };
}

/** AuthStore mit angemeldetem Nutzer (`null` = niemand angemeldet). */
export function makeAuthStore(username: string | null, role: UserRole = 'user'): AuthStore {
  const authStore = new AuthStore();
  runInAction(() => {
    authStore.currentUser = username === null ? null : makeUser({ username, role });
    authStore.initialized = true;
  });
  return authStore;
}
