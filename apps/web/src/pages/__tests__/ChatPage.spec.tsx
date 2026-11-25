import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import type { Project } from '../../api/types';
import { makeAuthStore, makeProject, makeUser } from '../../__tests__/factories';
import { ChatPageModel } from '../../models/ChatPageModel';
import { ChatStore } from '../../models/ChatStore';
import { ProjectsStore } from '../../models/ProjectsStore';
import { SpeechStore } from '../../models/SpeechStore';
import { ChatPage } from '../ChatPage';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

class FakeEventSource {
  onerror: unknown = null;
  addEventListener(): void {}
  close(): void {}
}

const alice = makeUser({ id: 'u1', username: 'alice' });
const bob = makeUser({ id: 'u2', username: 'bob' });

function renderChat(project: Project | null): {
  model: ChatPageModel;
  chatStore: ChatStore;
  unmount: () => void;
} {
  mockGql.mockImplementation(async (query: string) => {
    if (query.includes('EnterProject')) return { enterProject: { id: 'p1' } };
    if (query.includes('ChatState')) return { chatMessages: [], turnActive: false };
    return {
      projects: project === null ? [] : [project],
      templates: [],
      agentModels: [{ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }],
      previewGatewayPort: 4173,
      previewGatewayHttpsPort: null,
    };
  });
  const projectsStore = new ProjectsStore(makeAuthStore('alice'));
  const chatStore = new ChatStore();
  const speechStore = new SpeechStore(chatStore, { support: () => 'unsupported' });
  const model = new ChatPageModel(projectsStore, chatStore, speechStore);
  const { unmount } = render(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <Routes>
        <Route
          path="/projects/:id"
          element={
            <ChatPage
              model={model}
              projectsStore={projectsStore}
              chatStore={chatStore}
              speechStore={speechStore}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { model, chatStore, unmount };
}

describe('ChatPage', () => {
  beforeEach(() => {
    mockGql.mockReset();
    vi.stubGlobal('EventSource', FakeEventSource);
    // jsdom kennt Element.scrollTo nicht — die Liste scrollt bei neuen Nachrichten.
    Element.prototype.scrollTo = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('eigenes Projekt: Eingabe und Modellwahl sind da, kein Nur-Lese-Hinweis', async () => {
    renderChat(makeProject({ id: 'p1', name: 'Mein Projekt', owner: alice }));

    expect(await screen.findByText('Mein Projekt')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-model-select')).toBeInTheDocument();
    expect(document.querySelector('[data-testselector="chat-input"]')).not.toBeNull();
    expect(screen.queryByTestId('chat-readonly-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-send')).toBeDisabled();
  });

  it('fremdes Projekt: Nur-Lese-Hinweis statt Eingabe, keine Modellwahl', async () => {
    renderChat(makeProject({ id: 'p1', name: 'Bobs Projekt', owner: bob }));

    expect(await screen.findByTestId('chat-readonly-hint')).toHaveTextContent('bob');
    expect(document.querySelector('[data-testselector="chat-input"]')).toBeNull();
    expect(screen.queryByTestId('chat-model-select')).not.toBeInTheDocument();
  });

  it('unbekanntes Projekt: Hinweis „nicht gefunden"', async () => {
    renderChat(null);

    expect(await screen.findByTestId('chat-project-missing')).toBeInTheDocument();
  });

  it('Spalten-Schalter blenden Chat bzw. Preview aus', async () => {
    const { model } = renderChat(makeProject({ id: 'p1', name: 'Mein Projekt', owner: alice }));
    await screen.findByText('Mein Projekt');

    fireEvent.click(screen.getByTestId('chat-collapse-toggle'));
    expect(model.chatCollapsed).toBe(true);
    expect(screen.getByTestId('chat-column')).toHaveStyle({ display: 'none' });

    fireEvent.click(screen.getByTestId('chat-preview-toggle'));
    expect(screen.getByTestId('preview-column')).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('chat-column')).not.toHaveStyle({ display: 'none' });
  });

  it('Verlassen der Seite trennt den Chat', async () => {
    const { chatStore, unmount } = renderChat(makeProject({ id: 'p1', owner: alice }));
    await vi.waitFor(() => expect(chatStore.projectId).toBe('p1'));

    unmount();

    expect(chatStore.projectId).toBeNull();
  });
});
