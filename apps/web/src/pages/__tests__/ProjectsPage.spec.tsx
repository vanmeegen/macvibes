import { render, screen } from '@testing-library/react';
import { runInAction } from 'mobx';
import { MemoryRouter } from 'react-router-dom';
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
    owner: { id: 'u1', username: 'alice' },
    createdAt: '2026-07-01T10:00:00.000Z',
    lastActivityAt: '2026-07-02T12:00:00.000Z',
    sandboxStatus: 'stopped',
    previewHostPort: null,
  },
  {
    id: 'p2',
    name: 'Bobs Projekt',
    branchName: 'vibe/bobs-projekt',
    templateDir: 'react-starter',
    owner: { id: 'u2', username: 'bob' },
    createdAt: '2026-07-01T10:00:00.000Z',
    lastActivityAt: '2026-07-02T12:00:00.000Z',
    sandboxStatus: 'stopped',
    previewHostPort: null,
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

  function renderPage(): { authStore: AuthStore; projectsStore: ProjectsStore } {
    mockGql.mockResolvedValue({ projects, templates });

    const authStore = new AuthStore();
    runInAction(() => {
      authStore.currentUser = { id: 'u1', username: 'alice' };
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
});
