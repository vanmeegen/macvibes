import { fireEvent, render, screen } from '@testing-library/react';
import { runInAction } from 'mobx';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import type { Project, Template } from '../../api/types';
import { AuthStore } from '../../models/AuthStore';
import { CreateProjectModel } from '../../models/CreateProjectModel';
import { ProjectsStore } from '../../models/ProjectsStore';
import { ProjectsPage } from '../ProjectsPage';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

const projects: Project[] = [
  {
    id: 'p1',
    name: 'Mein Vibe-Projekt',
    branchName: 'vibe/mein-vibe-projekt',
    templateDir: 'react-starter',
    owner: { id: 'u1', username: 'alice', role: 'admin', approved: true, createdAt: 't0' },
    agentModel: 'claude-sonnet-5',
    createdAt: '2026-07-01T10:00:00.000Z',
    lastActivityAt: '2026-07-02T12:00:00.000Z',
    sandboxStatus: 'stopped',
    previewHostPort: null,
    previewStatus: 'stopped',
    turnActive: false,
  },
  {
    id: 'p2',
    name: 'Bobs Projekt',
    branchName: 'vibe/bobs-projekt',
    templateDir: 'react-starter',
    owner: { id: 'u2', username: 'bob', role: 'user', approved: true, createdAt: 't1' },
    agentModel: 'claude-sonnet-5',
    createdAt: '2026-07-01T10:00:00.000Z',
    lastActivityAt: '2026-07-02T12:00:00.000Z',
    sandboxStatus: 'stopped',
    previewHostPort: null,
    previewStatus: 'stopped',
    turnActive: false,
  },
];

const templates: Template[] = [
  {
    name: 'React Starter',
    description: 'Vite + React Grundgerüst',
    dir: 'react-starter',
    devCommand: 'bun run dev',
    previewPort: 3100,
  },
];

describe('ProjectsPage', () => {
  beforeEach(() => {
    mockGql.mockReset();
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  function renderPage(role: 'admin' | 'user' = 'admin'): {
    authStore: AuthStore;
    projectsStore: ProjectsStore;
  } {
    mockGql.mockResolvedValue({ projects, templates });

    const authStore = new AuthStore();
    runInAction(() => {
      authStore.currentUser = {
        id: 'u1',
        username: 'alice',
        role,
        approved: true,
        createdAt: 't0',
      };
      authStore.initialized = true;
    });
    const projectsStore = new ProjectsStore(authStore);
    const createProjectModel = new CreateProjectModel(projectsStore);

    render(
      <MemoryRouter>
        <ProjectsPage
          authStore={authStore}
          projectsStore={projectsStore}
          createProjectModel={createProjectModel}
        />
      </MemoryRouter>,
    );
    return { authStore, projectsStore };
  }

  it('Neuanlage-Flow: Name-Feld hat Fokus, Enter legt an und wechselt in den Chat', async () => {
    // createProject wird über den Query-Text erkannt, alles andere ist Laden.
    const created = { ...projects[0], id: 'p9', name: 'Blitz' };
    mockGql.mockImplementation(async (query: string) =>
      query.includes('createProject') ? { createProject: created } : { projects, templates },
    );

    const authStore = new AuthStore();
    runInAction(() => {
      authStore.currentUser = {
        id: 'u1',
        username: 'alice',
        role: 'admin',
        approved: true,
        createdAt: 't0',
      };
      authStore.initialized = true;
    });
    const projectsStore = new ProjectsStore(authStore);
    const createProjectModel = new CreateProjectModel(projectsStore);
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route
            path="/"
            element={
              <ProjectsPage
                authStore={authStore}
                projectsStore={projectsStore}
                createProjectModel={createProjectModel}
              />
            }
          />
          <Route path="/projects/:id" element={<div data-testselector="chat-page-stub" />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Mein Vibe-Projekt');
    fireEvent.click(screen.getByTestId('new-project-fab'));

    const nameInput = document.querySelector<HTMLInputElement>(
      '[data-testselector="new-project-name"]',
    );
    expect(nameInput).not.toBeNull();
    // Autofokus: sofort lostippen können.
    expect(document.activeElement).toBe(nameInput);

    fireEvent.change(nameInput as HTMLInputElement, { target: { value: 'Blitz' } });
    // Enter statt Klick auf "Erstellen" …
    fireEvent.keyDown(nameInput as HTMLInputElement, { key: 'Enter' });
    // … und nach dem Anlegen landet man direkt im Chat des neuen Projekts.
    expect(await screen.findByTestId('chat-page-stub')).toBeInTheDocument();
  });

  it('rendert die eigenen Projekte nach dem Laden (Default-Filter "mine")', async () => {
    renderPage();

    expect(await screen.findByText('Mein Vibe-Projekt')).toBeInTheDocument();
    // Bobs Projekt ist beim Default-Filter "Nur meine" nicht sichtbar.
    expect(screen.queryByText('Bobs Projekt')).not.toBeInTheDocument();
    expect(screen.getByText('von alice')).toBeInTheDocument();
    expect(screen.getByText('gestoppt')).toBeInTheDocument();
  });

  it('zeigt den FAB zum Anlegen eines neuen Projekts', async () => {
    renderPage();

    await screen.findByText('Mein Vibe-Projekt');
    expect(screen.getByTestId('new-project-fab')).toBeInTheDocument();
    expect(screen.getByTestId('project-filter-mine')).toBeInTheDocument();
    expect(screen.getByTestId('project-filter-all')).toBeInTheDocument();
  });

  it('zeigt den angemeldeten Benutzer in der AppBar', async () => {
    renderPage();

    await screen.findByText('Mein Vibe-Projekt');
    expect(screen.getByTestId('current-username')).toHaveTextContent('alice');
  });

  it('zeigt „arbeitet" im Status-Chip, wenn der Agent des Projekts gerade einen Turn hat', async () => {
    const working = [{ ...projects[0]!, sandboxStatus: 'running', turnActive: true }];
    mockGql.mockResolvedValue({ projects: working, templates });

    const authStore = new AuthStore();
    runInAction(() => {
      authStore.currentUser = {
        id: 'u1',
        username: 'alice',
        role: 'user',
        approved: true,
        createdAt: 't0',
      };
      authStore.initialized = true;
    });
    const projectsStore = new ProjectsStore(authStore);
    render(
      <MemoryRouter>
        <ProjectsPage
          authStore={authStore}
          projectsStore={projectsStore}
          createProjectModel={new CreateProjectModel(projectsStore)}
        />
      </MemoryRouter>,
    );

    await screen.findByText('Mein Vibe-Projekt');
    const chip = screen.getByTestId('project-status-p1');
    expect(chip).toHaveTextContent('arbeitet');
    expect(chip).toHaveAttribute('data-turn-active', 'true');
  });

  describe('Projektmenü (Umbenennen/Löschen)', () => {
    it('normale User: Menü auf ALLEN Karten, fremde nur mit „Kopieren und Anpassen"', async () => {
      const { projectsStore } = renderPage('user');
      await screen.findByText('Mein Vibe-Projekt');
      runInAction(() => projectsStore.setFilter('all'));
      await screen.findByText('Bobs Projekt');

      // Fremde Karte: Menü da, aber nur Kopieren — kein Umbenennen/Löschen.
      fireEvent.click(screen.getByTestId('project-menu-p2'));
      expect(await screen.findByTestId('project-copy-p2')).toBeInTheDocument();
      expect(screen.queryByTestId('project-rename-p2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('project-delete-p2')).not.toBeInTheDocument();
    });

    it('eigene Karte: Kopieren, Umbenennen und Löschen im Menü', async () => {
      renderPage('user');
      await screen.findByText('Mein Vibe-Projekt');

      fireEvent.click(screen.getByTestId('project-menu-p1'));
      expect(await screen.findByTestId('project-copy-p1')).toBeInTheDocument();
      expect(screen.getByTestId('project-rename-p1')).toBeInTheDocument();
      expect(screen.getByTestId('project-delete-p1')).toBeInTheDocument();
    });

    it('Admins sehen auf fremden Karten zusätzlich Umbenennen/Löschen', async () => {
      const { projectsStore } = renderPage('admin');
      await screen.findByText('Mein Vibe-Projekt');
      runInAction(() => projectsStore.setFilter('all'));
      await screen.findByText('Bobs Projekt');

      fireEvent.click(screen.getByTestId('project-menu-p2'));
      expect(await screen.findByTestId('project-copy-p2')).toBeInTheDocument();
      expect(screen.getByTestId('project-rename-p2')).toBeInTheDocument();
      expect(screen.getByTestId('project-delete-p2')).toBeInTheDocument();
    });

    it('öffnet über das Menü den Umbenennen-Dialog mit vorgefülltem Namen und benennt um', async () => {
      renderPage();
      await screen.findByText('Mein Vibe-Projekt');
      // Nach renderPage() setzen — renderPage() registriert selbst einen Mock.
      mockGql.mockImplementation(async (query: string) =>
        query.includes('renameProject')
          ? { renameProject: { id: 'p1', name: 'Umbenannt' } }
          : { projects, templates },
      );

      fireEvent.click(screen.getByTestId('project-menu-p1'));
      fireEvent.click(await screen.findByTestId('project-rename-p1'));

      const nameInput = document.querySelector<HTMLInputElement>(
        '[data-testselector="rename-project-name"]',
      );
      expect(nameInput).not.toBeNull();
      expect(nameInput?.value).toBe('Mein Vibe-Projekt');

      fireEvent.change(nameInput as HTMLInputElement, { target: { value: 'Umbenannt' } });
      fireEvent.click(screen.getByTestId('rename-confirm'));

      expect(await screen.findByText('Umbenannt')).toBeInTheDocument();
      expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('renameProject'), {
        id: 'p1',
        name: 'Umbenannt',
      });
    });

    it('„Kopieren und Anpassen": Dialog mit Namensvorschlag, Anlegen führt in den neuen Chat', async () => {
      const copied = { ...projects[0], id: 'p-kopie', name: 'Bobs Projekt Kopie' };
      const authStore = new AuthStore();
      runInAction(() => {
        authStore.currentUser = {
          id: 'u1',
          username: 'alice',
          role: 'user',
          approved: true,
          createdAt: 't0',
        };
        authStore.initialized = true;
      });
      const projectsStore = new ProjectsStore(authStore);
      const createProjectModel = new CreateProjectModel(projectsStore);
      mockGql.mockImplementation(async (query: string) =>
        query.includes('copyProject') ? { copyProject: copied } : { projects, templates },
      );
      render(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route
              path="/"
              element={
                <ProjectsPage
                  authStore={authStore}
                  projectsStore={projectsStore}
                  createProjectModel={createProjectModel}
                />
              }
            />
            <Route path="/projects/:id" element={<div data-testselector="chat-page-stub" />} />
          </Routes>
        </MemoryRouter>,
      );
      await screen.findByText('Mein Vibe-Projekt');
      runInAction(() => projectsStore.setFilter('all'));
      await screen.findByText('Bobs Projekt');

      fireEvent.click(screen.getByTestId('project-menu-p2'));
      fireEvent.click(await screen.findByTestId('project-copy-p2'));

      const nameInput = document.querySelector<HTMLInputElement>(
        '[data-testselector="copy-project-name"]',
      );
      expect(nameInput?.value).toBe('Bobs Projekt Kopie');

      fireEvent.click(screen.getByTestId('copy-confirm'));
      expect(await screen.findByTestId('chat-page-stub')).toBeInTheDocument();
      expect(mockGql).toHaveBeenCalledWith(expect.stringContaining('copyProject'), {
        sourceId: 'p2',
        name: 'Bobs Projekt Kopie',
      });
    });

    it('öffnet über das Menü den Lösch-Bestätigungsdialog', async () => {
      renderPage();
      await screen.findByText('Mein Vibe-Projekt');

      fireEvent.click(screen.getByTestId('project-menu-p1'));
      fireEvent.click(await screen.findByTestId('project-delete-p1'));

      expect(await screen.findByText('Projekt löschen?')).toBeInTheDocument();
    });
  });
});
