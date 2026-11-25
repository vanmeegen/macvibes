import { runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import type { Project } from '../../api/types';
import { makeAuthStore, makeProject, makeUser } from '../../__tests__/factories';
import { ChatPageModel, type PageLocation } from '../ChatPageModel';
import { ChatStore } from '../ChatStore';
import { ProjectsStore } from '../ProjectsStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  onerror: unknown = null;
  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {
    this.closed = true;
  }
}

const alice = makeUser({ id: 'u1', username: 'alice' });
const bob = makeUser({ id: 'u2', username: 'bob' });

/** Beantwortet jede Abfrage passend zum Query-Text und zeichnet die Aufrufe auf. */
function serveProjects(projects: Project[]): string[] {
  const calls: string[] = [];
  mockGql.mockImplementation(async (query: string) => {
    if (query.includes('EnterProject')) {
      calls.push('enter');
      return { enterProject: { id: 'p1' } };
    }
    if (query.includes('ChatState')) {
      calls.push('chat');
      return { chatMessages: [], turnActive: false };
    }
    calls.push('projects');
    return {
      projects,
      templates: [],
      agentModels: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }],
      previewGatewayPort: 4173,
      previewGatewayHttpsPort: null,
    };
  });
  return calls;
}

function makeModel(opts: { projects?: Project[]; location?: PageLocation } = {}): {
  model: ChatPageModel;
  projectsStore: ProjectsStore;
  chatStore: ChatStore;
  speech: { init: ReturnType<typeof vi.fn> };
} {
  const projectsStore = new ProjectsStore(makeAuthStore('alice'));
  runInAction(() => {
    projectsStore.projects = opts.projects ?? [];
  });
  const chatStore = new ChatStore();
  const speech = { init: vi.fn() };
  const location = opts.location ?? { hostname: 'mein-mac.local', protocol: 'http:' };
  const model = new ChatPageModel(projectsStore, chatStore, speech, () => location);
  return { model, projectsStore, chatStore, speech };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ChatPageModel', () => {
  beforeEach(() => {
    mockGql.mockReset();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('open/close — Lebenszyklus der Seite', () => {
    it('Projekt schon in der Liste: startet die Sandbox eager und verbindet den Chat', async () => {
      const calls = serveProjects([makeProject({ id: 'p1', owner: alice })]);
      const { model, chatStore, speech } = makeModel({
        projects: [makeProject({ id: 'p1', owner: alice })],
      });

      model.open('p1');
      await settle();

      expect(calls).toContain('enter');
      expect(calls).toContain('chat');
      expect(chatStore.projectId).toBe('p1');
      expect(speech.init).toHaveBeenCalledTimes(1);
      model.close();
    });

    it('leere Liste (Direktaufruf der URL): lädt erst, verbindet dann', async () => {
      const calls = serveProjects([makeProject({ id: 'p1', owner: alice })]);
      const { model, chatStore } = makeModel();

      model.open('p1');
      expect(chatStore.projectId).toBeNull();
      await settle();

      expect(calls[0]).toBe('projects');
      expect(calls).toContain('enter');
      expect(chatStore.projectId).toBe('p1');
      model.close();
    });

    it('unbekanntes Projekt: kein enterProject, kein Chat — aber der Hinweis „nicht gefunden"', async () => {
      const calls = serveProjects([]);
      const { model, chatStore } = makeModel();

      model.open('gibts-nicht');
      await settle();

      expect(calls).not.toContain('enter');
      expect(chatStore.projectId).toBeNull();
      expect(model.projectMissing).toBe(true);
      model.close();
    });

    it('close trennt den Chat und beendet das Polling', async () => {
      serveProjects([makeProject({ id: 'p1', owner: alice })]);
      const { model, chatStore, projectsStore } = makeModel({
        projects: [makeProject({ id: 'p1', owner: alice })],
      });
      model.open('p1');
      await settle();
      expect(projectsStore.pollTimer).not.toBeNull();

      model.close();

      expect(chatStore.projectId).toBeNull();
      expect(projectsStore.pollTimer).toBeNull();
      expect(FakeEventSource.instances.every((es) => es.closed)).toBe(true);
    });

    it('nach close reagiert das Modell nicht mehr auf die Projektliste', async () => {
      const calls = serveProjects([]);
      const { model, projectsStore } = makeModel();
      model.open('p1');
      await settle();
      model.close();
      calls.length = 0;

      runInAction(() => {
        projectsStore.projects = [makeProject({ id: 'p1', owner: alice })];
      });
      await settle();

      expect(calls).toEqual([]);
    });

    it('open verwirft einen Fehler der zuvor besuchten Seite', async () => {
      serveProjects([makeProject({ id: 'p1', owner: alice })]);
      const { model, projectsStore } = makeModel({
        projects: [makeProject({ id: 'p1', owner: alice })],
      });
      runInAction(() => {
        projectsStore.error = 'Alter Fehler aus der Übersicht';
      });

      model.open('p1');
      await settle();

      expect(projectsStore.error).toBeNull();
      model.close();
    });

    it('open blendet beide Spalten wieder ein (kein versteckter Chat beim Projektwechsel)', () => {
      serveProjects([]);
      const { model } = makeModel();
      model.toggleChatCollapsed();

      model.open('p1');

      expect(model.chatCollapsed).toBe(false);
      expect(model.previewCollapsed).toBe(false);
      model.close();
    });
  });

  describe('Ableitungen', () => {
    it('eigenes Projekt: Owner, schreibbar, Modellwahl sichtbar', async () => {
      serveProjects([makeProject({ id: 'p1', owner: alice })]);
      const { model } = makeModel({ projects: [makeProject({ id: 'p1', owner: alice })] });
      model.open('p1');
      await settle();

      expect(model.isOwner).toBe(true);
      expect(model.readOnly).toBe(false);
      expect(model.showModelSelect).toBe(true);
      model.close();
    });

    it('fremdes Projekt: Nur-Lese-Modus, keine Modellwahl', async () => {
      serveProjects([makeProject({ id: 'p1', owner: bob })]);
      const { model } = makeModel({ projects: [makeProject({ id: 'p1', owner: bob })] });
      model.open('p1');
      await settle();

      expect(model.isOwner).toBe(false);
      expect(model.readOnly).toBe(true);
      expect(model.showModelSelect).toBe(false);
      model.close();
    });

    it('Preview-URL zeigt aufs Gateway, sobald Sandbox läuft und Preview bereit ist', async () => {
      const running = makeProject({
        id: 'p1',
        owner: alice,
        sandboxStatus: 'running',
        previewStatus: 'ready',
      });
      serveProjects([running]);
      const { model } = makeModel({ projects: [running] });
      model.open('p1');
      await settle();

      expect(model.preview.showIframe).toBe(true);
      expect(model.preview.url).toBe('http://mein-mac.local:4173/p/p1/');
      model.close();
    });

    it('keine Preview-URL, solange die Sandbox nicht läuft (Gateway-Port wird zurückgehalten)', async () => {
      const stopped = makeProject({ id: 'p1', owner: alice, previewStatus: 'ready' });
      serveProjects([stopped]);
      const { model } = makeModel({ projects: [stopped] });
      model.open('p1');
      await settle();

      expect(model.preview.showIframe).toBe(false);
      model.close();
    });

    it('workingLabel folgt dem Sandbox-Status des Projekts', async () => {
      const starting = makeProject({ id: 'p1', owner: alice, sandboxStatus: 'starting' });
      serveProjects([starting]);
      const { model } = makeModel({ projects: [starting] });
      model.open('p1');

      expect(model.workingLabel).toBe('MicroVM startet — Workspace wird vorbereitet …');
      model.close();
    });
  });

  describe('Spalten ein-/ausblenden', () => {
    it('Chat und Preview lassen sich einzeln togglen', () => {
      const { model } = makeModel();
      expect(model.chatCollapsed).toBe(false);
      model.toggleChatCollapsed();
      expect(model.chatCollapsed).toBe(true);
      model.toggleChatCollapsed();
      expect(model.chatCollapsed).toBe(false);

      model.togglePreviewCollapsed();
      expect(model.previewCollapsed).toBe(true);
      model.togglePreviewCollapsed();
      expect(model.previewCollapsed).toBe(false);
    });

    it('wechselseitig exklusiv — nie beide ausgeblendet (leerer Screen)', () => {
      const { model } = makeModel();
      model.toggleChatCollapsed();
      // Preview ausblenden hebt das Chat-Ausblenden auf.
      model.togglePreviewCollapsed();
      expect(model.previewCollapsed).toBe(true);
      expect(model.chatCollapsed).toBe(false);
      // Und umgekehrt.
      model.toggleChatCollapsed();
      expect(model.chatCollapsed).toBe(true);
      expect(model.previewCollapsed).toBe(false);
    });
  });
});
