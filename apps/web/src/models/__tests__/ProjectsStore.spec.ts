import { runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import type { Project, Template } from '../../api/types';
import { AuthStore } from '../AuthStore';
import { agentWorkingLabel, PROJECT_FILTER_STORAGE_KEY, ProjectsStore } from '../ProjectsStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    name: `Projekt ${overrides.id}`,
    branchName: `vibe/${overrides.id}`,
    templateDir: 'react-starter',
    owner: { id: 'u1', username: 'alice', role: 'admin', approved: true, createdAt: 't0' },
    agentModel: 'claude-sonnet-5',
    createdAt: '2026-07-01T10:00:00.000Z',
    lastActivityAt: '2026-07-02T12:00:00.000Z',
    sandboxStatus: 'stopped',
    previewHostPort: null,
    previewStatus: 'stopped',
    ...overrides,
  };
}

const templates: Template[] = [
  {
    name: 'React Starter',
    description: 'Vite + React Grundgerüst',
    dir: 'react-starter',
    devCommand: 'bun run dev',
    previewPort: 3100,
  },
];

function makeAuthStore(username: string | null): AuthStore {
  const authStore = new AuthStore();
  runInAction(() => {
    authStore.currentUser =
      username === null
        ? null
        : { id: 'u1', username, role: 'user', approved: true, createdAt: 't0' };
    authStore.initialized = true;
  });
  return authStore;
}

describe('agentWorkingLabel — sichtbares Boot-Feedback statt gefühltem Hänger', () => {
  it('zeigt beim VM-Boot klar an, dass die MicroVM startet', () => {
    expect(agentWorkingLabel('starting')).toBe('MicroVM startet — Workspace wird vorbereitet …');
  });

  it('zeigt bei gestoppter/stoppender Sandbox, dass sie gleich gestartet wird', () => {
    expect(agentWorkingLabel('stopped')).toBe('Sandbox wird gestartet …');
    expect(agentWorkingLabel('stopping')).toBe('Sandbox wird gestartet …');
  });

  it('zeigt bei laufender Sandbox den normalen Agenten-Status', () => {
    expect(agentWorkingLabel('running')).toBe('Agent arbeitet …');
  });
});

describe('ProjectsStore', () => {
  beforeEach(() => {
    mockGql.mockReset();
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  describe('Filter-Persistenz', () => {
    it('verwendet "mine" als Default, wenn localStorage leer ist', () => {
      const store = new ProjectsStore(makeAuthStore('alice'));
      expect(store.filter).toBe('mine');
    });

    it('liest einen gespeicherten Filter aus localStorage', () => {
      window.localStorage.setItem(PROJECT_FILTER_STORAGE_KEY, 'all');
      const store = new ProjectsStore(makeAuthStore('alice'));
      expect(store.filter).toBe('all');
    });

    it('ignoriert ungültige Werte in localStorage', () => {
      window.localStorage.setItem(PROJECT_FILTER_STORAGE_KEY, 'quatsch');
      const store = new ProjectsStore(makeAuthStore('alice'));
      expect(store.filter).toBe('mine');
    });

    it('persistiert setFilter in localStorage', () => {
      const store = new ProjectsStore(makeAuthStore('alice'));
      store.setFilter('all');
      expect(store.filter).toBe('all');
      expect(window.localStorage.getItem(PROJECT_FILTER_STORAGE_KEY)).toBe('all');
    });
  });

  describe('visibleProjects', () => {
    it('zeigt bei Filter "mine" nur eigene Projekte', () => {
      const store = new ProjectsStore(makeAuthStore('alice'));
      runInAction(() => {
        store.projects = [
          makeProject({
            id: 'p1',
            owner: { id: 'u1', username: 'alice', role: 'admin', approved: true, createdAt: 't0' },
          }),
          makeProject({
            id: 'p2',
            owner: { id: 'u2', username: 'bob', role: 'user', approved: true, createdAt: 't1' },
          }),
        ];
      });

      store.setFilter('mine');
      expect(store.visibleProjects.map((p) => p.id)).toEqual(['p1']);
    });

    it('zeigt bei Filter "all" alle Projekte', () => {
      const store = new ProjectsStore(makeAuthStore('alice'));
      runInAction(() => {
        store.projects = [
          makeProject({
            id: 'p1',
            owner: { id: 'u1', username: 'alice', role: 'admin', approved: true, createdAt: 't0' },
          }),
          makeProject({
            id: 'p2',
            owner: { id: 'u2', username: 'bob', role: 'user', approved: true, createdAt: 't1' },
          }),
        ];
      });

      store.setFilter('all');
      expect(store.visibleProjects.map((p) => p.id)).toEqual(['p1', 'p2']);
    });

    it('zeigt bei Filter "mine" ohne angemeldeten Benutzer keine Projekte', () => {
      const store = new ProjectsStore(makeAuthStore(null));
      runInAction(() => {
        store.projects = [makeProject({ id: 'p1' })];
      });

      store.setFilter('mine');
      expect(store.visibleProjects).toEqual([]);
    });
  });

  describe('load', () => {
    it('lädt Projekte und Templates', async () => {
      const projects = [makeProject({ id: 'p1' })];
      mockGql.mockResolvedValueOnce({ projects, templates });
      const store = new ProjectsStore(makeAuthStore('alice'));

      await store.load();

      expect(store.projects).toEqual(projects);
      expect(store.templates).toEqual(templates);
      expect(store.loading).toBe(false);
      expect(store.error).toBeNull();
    });

    it('speichert die Fehlermeldung bei Misserfolg', async () => {
      mockGql.mockRejectedValueOnce(new Error('Nicht angemeldet'));
      const store = new ProjectsStore(makeAuthStore('alice'));

      await store.load();

      expect(store.projects).toEqual([]);
      expect(store.error).toBe('Nicht angemeldet');
      expect(store.loading).toBe(false);
    });
  });

  describe('deleteProject', () => {
    it('entfernt das Projekt aus der Liste bei Erfolg', async () => {
      const store = new ProjectsStore(makeAuthStore('alice'));
      runInAction(() => {
        store.projects = [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })];
      });
      mockGql.mockResolvedValueOnce({ deleteProject: true });

      const ok = await store.deleteProject('p1');

      expect(ok).toBe(true);
      expect(store.projects.map((p) => p.id)).toEqual(['p2']);
      expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('deleteProject'), { id: 'p1' });
    });

    it('speichert die Fehlermeldung und behält die Liste bei Misserfolg', async () => {
      const store = new ProjectsStore(makeAuthStore('alice'));
      runInAction(() => {
        store.projects = [makeProject({ id: 'p1' })];
      });
      mockGql.mockRejectedValueOnce(new Error('Nur der Besitzer darf löschen'));

      const ok = await store.deleteProject('p1');

      expect(ok).toBe(false);
      expect(store.projects.map((p) => p.id)).toEqual(['p1']);
      expect(store.error).toBe('Nur der Besitzer darf löschen');
    });

    it('confirmDelete löscht das per requestDelete vorgemerkte Projekt', async () => {
      const store = new ProjectsStore(makeAuthStore('alice'));
      runInAction(() => {
        store.projects = [makeProject({ id: 'p1' })];
      });
      mockGql.mockResolvedValueOnce({ deleteProject: true });

      store.requestDelete('p1');
      expect(store.pendingDeleteProject?.id).toBe('p1');

      const ok = await store.confirmDelete();

      expect(ok).toBe(true);
      expect(store.pendingDeleteId).toBeNull();
      expect(store.projects).toEqual([]);
    });
  });
});

describe('Modellwahl pro Projekt (Dropdown im Chat)', () => {
  beforeEach(() => {
    mockGql.mockReset();
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  function storeWithProject(): ProjectsStore {
    const store = new ProjectsStore(makeAuthStore('alice'));
    runInAction(() => {
      store.projects = [makeProject({ id: 'p1' })];
    });
    return store;
  }

  it('setProjectModel ruft die Mutation und übernimmt das neue Modell', async () => {
    const store = storeWithProject();
    mockGql.mockResolvedValueOnce({
      setProjectModel: { id: 'p1', agentModel: 'qwen3.6-coder' },
    });
    const ok = await store.setProjectModel('p1', 'qwen3.6-coder');
    expect(ok).toBe(true);
    expect(store.projects[0]?.agentModel).toBe('qwen3.6-coder');
    expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('setProjectModel'), {
      projectId: 'p1',
      model: 'qwen3.6-coder',
    });
  });

  it('rollt bei Server-Fehler zurück und meldet den Fehler', async () => {
    const store = storeWithProject();
    mockGql.mockRejectedValueOnce(new Error('Unbekanntes Modell "gpt-5"'));
    const ok = await store.setProjectModel('p1', 'gpt-5');
    expect(ok).toBe(false);
    expect(store.projects[0]?.agentModel).toBe('claude-sonnet-5');
    expect(store.error).toContain('Unbekanntes Modell');
  });

  it('load lädt den Modellkatalog (agentModels) mit', async () => {
    const store = new ProjectsStore(makeAuthStore('alice'));
    mockGql.mockResolvedValueOnce({
      projects: [],
      templates,
      previewGatewayPort: 4173,
      agentModels: [
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', slow: false },
        { id: 'qwen3.6-coder', label: 'Qwen 27B (lokal)', slow: true },
      ],
    });
    await store.load();
    expect(store.agentModels.map((m) => m.id)).toEqual(['claude-sonnet-5', 'qwen3.6-coder']);
  });
});
