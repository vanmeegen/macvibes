import { runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gqlRequest } from '../../api/graphqlClient';
import type { Template } from '../../api/types';
import { AuthStore } from '../AuthStore';
import { CreateProjectModel } from '../CreateProjectModel';
import { ProjectsStore } from '../ProjectsStore';

vi.mock('../../api/graphqlClient', () => ({
  gqlRequest: vi.fn(),
}));

const mockGql = vi.mocked(gqlRequest);

const templates: Template[] = [
  {
    name: 'React Starter',
    description: 'Vite + React Grundgerüst',
    dir: 'react-starter',
    devCommand: 'bun run dev',
    previewPort: 3100,
  },
  {
    name: 'Bun API',
    description: 'Minimaler Bun-HTTP-Server',
    dir: 'bun-api',
    devCommand: 'bun run dev',
    previewPort: 3200,
  },
];

function makeModel(): { model: CreateProjectModel; projectsStore: ProjectsStore } {
  const authStore = new AuthStore();
  const projectsStore = new ProjectsStore(authStore);
  runInAction(() => {
    projectsStore.templates = templates;
  });
  return { model: new CreateProjectModel(projectsStore), projectsStore };
}

describe('CreateProjectModel', () => {
  beforeEach(() => {
    mockGql.mockReset();
    window.localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('openDialog setzt den Zustand zurück und wählt das erste Template vor', () => {
    const { model } = makeModel();
    model.setName('alt');
    model.openDialog();

    expect(model.open).toBe(true);
    expect(model.name).toBe('');
    expect(model.error).toBeNull();
    expect(model.selectedTemplateDir).toBe('react-starter');
  });

  it('validiert: leerer Name führt zu Fehler und keinem Request', async () => {
    const { model } = makeModel();
    model.openDialog();
    model.setName('   ');

    await model.submit();

    expect(model.error).toBe('Bitte einen Projektnamen eingeben.');
    expect(model.open).toBe(true);
    expect(mockGql).not.toHaveBeenCalled();
  });

  it('validiert: fehlende Template-Auswahl führt zu Fehler', async () => {
    const { model } = makeModel();
    model.openDialog();
    model.setName('Mein Projekt');
    model.setSelectedTemplateDir('');

    await model.submit();

    expect(model.error).toBe('Bitte eine Vorlage auswählen.');
    expect(mockGql).not.toHaveBeenCalled();
  });

  it('legt bei Erfolg das Projekt an, schließt den Dialog und lädt die Projektliste neu', async () => {
    const { model, projectsStore } = makeModel();
    const createdProject = {
      id: 'p1',
      name: 'Mein Projekt',
      branchName: 'vibe/mein-projekt',
      templateDir: 'bun-api',
      owner: { id: 'u1', username: 'alice' },
      createdAt: '2026-07-03T08:00:00.000Z',
      lastActivityAt: '2026-07-03T08:00:00.000Z',
      sandboxStatus: 'stopped',
    };
    // 1. Aufruf: createProject-Mutation, 2. Aufruf: Neuladen der Projektliste.
    mockGql
      .mockResolvedValueOnce({ createProject: createdProject })
      .mockResolvedValueOnce({ projects: [createdProject], templates });

    model.openDialog();
    model.setName('  Mein Projekt  ');
    model.setSelectedTemplateDir('bun-api');

    await model.submit();

    expect(mockGql).toHaveBeenNthCalledWith(1, expect.stringContaining('createProject'), {
      name: 'Mein Projekt',
      templateDir: 'bun-api',
    });
    expect(mockGql).toHaveBeenNthCalledWith(2, expect.stringContaining('projects'));
    expect(model.open).toBe(false);
    expect(model.error).toBeNull();
    expect(model.submitting).toBe(false);
    expect(projectsStore.projects.map((p) => p.id)).toEqual(['p1']);
  });

  it('submit liefert die ID des neuen Projekts (für den direkten Chat-Wechsel)', async () => {
    const { model } = makeModel();
    const created = {
      id: 'p9',
      name: 'Blitz',
      branchName: 'alice/blitz',
      templateDir: 'react-starter',
      owner: { id: 'u1', username: 'alice' },
      createdAt: '2026-07-05T08:00:00.000Z',
      lastActivityAt: '2026-07-05T08:00:00.000Z',
      sandboxStatus: 'stopped',
    };
    mockGql
      .mockResolvedValueOnce({ createProject: created })
      .mockResolvedValueOnce({ projects: [created], templates });

    model.openDialog();
    model.setName('Blitz');

    expect(await model.submit()).toBe('p9');
  });

  it('submit liefert null, wenn das Anlegen scheitert (kein Chat-Wechsel)', async () => {
    const { model } = makeModel();
    mockGql.mockRejectedValueOnce(new Error('kaputt'));

    model.openDialog();
    model.setName('X');

    expect(await model.submit()).toBeNull();
  });

  it('zeigt die Server-Fehlermeldung und lässt den Dialog offen', async () => {
    const { model, projectsStore } = makeModel();
    mockGql.mockRejectedValueOnce(new Error('Projektname bereits vergeben'));

    model.openDialog();
    model.setName('Duplikat');

    await model.submit();

    expect(model.error).toBe('Projektname bereits vergeben');
    expect(model.open).toBe(true);
    expect(model.submitting).toBe(false);
    // Kein Neuladen der Projektliste im Fehlerfall.
    expect(mockGql).toHaveBeenCalledTimes(1);
    expect(projectsStore.projects).toEqual([]);
  });
});
