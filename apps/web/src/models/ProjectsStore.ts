import { makeAutoObservable, runInAction } from 'mobx';
import { gqlRequest } from '../api/graphqlClient';
import type { AgentModelInfo, Project, Template } from '../api/types';
import type { AuthStore } from './AuthStore';

export type ProjectFilter = 'mine' | 'all';

export const PROJECT_FILTER_STORAGE_KEY = 'macvibes.projectFilter';

const PROJECTS_AND_TEMPLATES_QUERY = /* GraphQL */ `
  query ProjectsAndTemplates {
    previewGatewayPort
    projects {
      id
      name
      branchName
      templateDir
      owner {
        id
        username
      }
      agentModel
      createdAt
      lastActivityAt
      sandboxStatus
      previewHostPort
      previewStatus
    }
    agentModels {
      id
      label
      slow
    }
    templates {
      name
      description
      dir
      devCommand
      previewPort
    }
  }
`;

const DELETE_PROJECT_MUTATION = /* GraphQL */ `
  mutation DeleteProject($id: ID!) {
    deleteProject(id: $id)
  }
`;

const RENAME_PROJECT_MUTATION = /* GraphQL */ `
  mutation RenameProject($id: ID!, $name: String!) {
    renameProject(id: $id, name: $name) {
      id
      name
    }
  }
`;

const ENTER_PROJECT_MUTATION = /* GraphQL */ `
  mutation EnterProject($id: ID!) {
    enterProject(id: $id) {
      id
      sandboxStatus
    }
  }
`;

const LEAVE_PROJECT_MUTATION = /* GraphQL */ `
  mutation LeaveProject($id: ID!) {
    leaveProject(id: $id)
  }
`;

const SET_PROJECT_MODEL_MUTATION = /* GraphQL */ `
  mutation SetProjectModel($projectId: ID!, $model: String!) {
    setProjectModel(projectId: $projectId, model: $model) {
      id
      agentModel
    }
  }
`;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readFilterFromStorage(): ProjectFilter {
  try {
    const stored = window.localStorage.getItem(PROJECT_FILTER_STORAGE_KEY);
    if (stored === 'mine' || stored === 'all') {
      return stored;
    }
  } catch (err) {
    // localStorage kann z. B. im Private-Modus fehlen — Default verwenden.
    console.error('Projektfilter konnte nicht aus localStorage gelesen werden', err);
  }
  return 'mine';
}

/** Formatiert einen Server-Zeitstempel (ISO-String oder Epoch-Millis) deutsch. */
export function formatTimestamp(value: string): string {
  const millis = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (Number.isNaN(millis)) {
    return value;
  }
  return new Date(millis).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Text des „Agent arbeitet"-Indikators, abhängig vom Sandbox-Status: während
 * die MicroVM bootet, sieht der User WARUM noch nichts passiert (kein
 * gefühlter Hänger).
 */
export function agentWorkingLabel(sandboxStatus: string): string {
  switch (sandboxStatus) {
    case 'starting':
      return 'MicroVM startet — Workspace wird vorbereitet …';
    case 'stopped':
    case 'stopping':
      return 'Sandbox wird gestartet …';
    default:
      return 'Agent arbeitet …';
  }
}

/** Deutsche Anzeige des Sandbox-Status. */
export function sandboxStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return 'läuft';
    case 'starting':
      return 'startet';
    case 'stopped':
      return 'gestoppt';
    default:
      return status;
  }
}

/**
 * Store für Projekte und Templates inkl. Sichtbarkeitsfilter
 * ("Nur meine" / "Alle", persistiert in localStorage).
 */
export class ProjectsStore {
  projects: Project[] = [];
  templates: Template[] = [];
  /** Wählbare Agenten-Modelle (Katalog vom Server, fürs Dropdown im Chat). */
  agentModels: AgentModelInfo[] = [];
  /** Fester Port des Preview-Gateways — Basis der iframe-URL (Remote/VPN). */
  previewGatewayPort: number | null = null;
  filter: ProjectFilter = readFilterFromStorage();
  error: string | null = null;
  loading = false;
  /** Projekt-ID, für die gerade der Lösch-Bestätigungsdialog offen ist. */
  pendingDeleteId: string | null = null;
  /** Projekt-ID, für die gerade der Umbenennen-Dialog offen ist. */
  pendingRenameId: string | null = null;
  /** Eingabewert im Umbenennen-Dialog (vorgefüllt mit dem aktuellen Namen). */
  renameName = '';
  /** Fehler im Umbenennen-Dialog — der Dialog bleibt offen, Name korrigierbar. */
  renameError: string | null = null;
  /** Interval-Handle fürs Status-Polling — bewusst nicht observable. */
  pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly authStore: AuthStore) {
    makeAutoObservable(this, { pollTimer: false }, { autoBind: true });
  }

  get visibleProjects(): Project[] {
    if (this.filter === 'all') {
      return this.projects;
    }
    const username = this.authStore.currentUser?.username;
    return this.projects.filter((p) => p.owner.username === username);
  }

  get pendingDeleteProject(): Project | null {
    if (this.pendingDeleteId === null) {
      return null;
    }
    return this.projects.find((p) => p.id === this.pendingDeleteId) ?? null;
  }

  isOwn(project: Project): boolean {
    return project.owner.username === this.authStore.currentUser?.username;
  }

  /** Kartenmenü (Umbenennen/Löschen): Eigentümer immer, Admins überall. */
  canManage(project: Project): boolean {
    return this.isOwn(project) || this.authStore.isAdmin;
  }

  setFilter(filter: ProjectFilter): void {
    this.filter = filter;
    try {
      window.localStorage.setItem(PROJECT_FILTER_STORAGE_KEY, filter);
    } catch (err) {
      console.error('Projektfilter konnte nicht in localStorage gespeichert werden', err);
    }
  }

  requestDelete(id: string): void {
    this.pendingDeleteId = id;
  }

  get pendingRenameProject(): Project | null {
    if (this.pendingRenameId === null) {
      return null;
    }
    return this.projects.find((p) => p.id === this.pendingRenameId) ?? null;
  }

  get canConfirmRename(): boolean {
    return this.renameName.trim().length > 0;
  }

  requestRename(id: string): void {
    const project = this.projects.find((p) => p.id === id);
    this.pendingRenameId = id;
    this.renameName = project?.name ?? '';
    this.renameError = null;
  }

  cancelRename(): void {
    this.pendingRenameId = null;
    this.renameError = null;
  }

  setRenameName(name: string): void {
    this.renameName = name;
    this.renameError = null;
  }

  /**
   * Benennt das vorgemerkte Projekt um. Bei Server-Fehler (z. B. doppelter
   * Name) bleibt der Dialog offen, damit der Name korrigiert werden kann.
   */
  async confirmRename(): Promise<boolean> {
    const id = this.pendingRenameId;
    const name = this.renameName.trim();
    if (id === null || name.length === 0) {
      return false;
    }
    try {
      const data = await gqlRequest<{ renameProject: { id: string; name: string } }>(
        RENAME_PROJECT_MUTATION,
        { id, name },
      );
      runInAction(() => {
        const project = this.projects.find((p) => p.id === id);
        if (project) {
          project.name = data.renameProject.name;
        }
        this.pendingRenameId = null;
        this.renameError = null;
      });
      return true;
    } catch (err) {
      console.error('ProjectsStore.confirmRename fehlgeschlagen', err);
      runInAction(() => {
        this.renameError = toErrorMessage(err);
      });
      return false;
    }
  }

  cancelDelete(): void {
    this.pendingDeleteId = null;
  }

  async confirmDelete(): Promise<boolean> {
    const id = this.pendingDeleteId;
    this.pendingDeleteId = null;
    if (id === null) {
      return false;
    }
    return this.deleteProject(id);
  }

  /** Lädt Projekte und Templates in einem Request. */
  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const data = await gqlRequest<{
        projects: Project[];
        templates: Template[];
        previewGatewayPort: number;
        agentModels: AgentModelInfo[];
      }>(PROJECTS_AND_TEMPLATES_QUERY);
      runInAction(() => {
        this.projects = data.projects;
        this.templates = data.templates;
        this.previewGatewayPort = data.previewGatewayPort;
        this.agentModels = data.agentModels;
      });
    } catch (err) {
      console.error('ProjectsStore.load fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  /** Stilles Nachladen fürs Status-Polling — ohne Lade-Spinner, Fehler nur geloggt. */
  async refresh(): Promise<void> {
    try {
      const data = await gqlRequest<{
        projects: Project[];
        templates: Template[];
        previewGatewayPort: number;
        agentModels: AgentModelInfo[];
      }>(PROJECTS_AND_TEMPLATES_QUERY);
      runInAction(() => {
        this.projects = data.projects;
        this.templates = data.templates;
        this.previewGatewayPort = data.previewGatewayPort;
        this.agentModels = data.agentModels;
      });
    } catch (err) {
      console.error('ProjectsStore.refresh fehlgeschlagen', err);
    }
  }

  startPolling(intervalMs = 2000): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Startet die Sandbox des Projekts (nur Owner, serverseitig geprüft). */
  async enterProject(id: string): Promise<void> {
    try {
      await gqlRequest<{ enterProject: { id: string } }>(ENTER_PROJECT_MUTATION, { id });
      await this.refresh();
    } catch (err) {
      console.error('ProjectsStore.enterProject fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
    }
  }

  /**
   * Modellwahl pro Projekt (Dropdown im Chat): optimistisch umschalten, bei
   * Server-Fehler zurückrollen. Der NÄCHSTE Turn nutzt das neue Modell.
   */
  async setProjectModel(projectId: string, model: string): Promise<boolean> {
    const project = this.projects.find((p) => p.id === projectId);
    const previous = project?.agentModel ?? null;
    if (project) {
      project.agentModel = model;
    }
    try {
      await gqlRequest<{ setProjectModel: { id: string; agentModel: string } }>(
        SET_PROJECT_MODEL_MUTATION,
        { projectId, model },
      );
      return true;
    } catch (err) {
      console.error('ProjectsStore.setProjectModel fehlgeschlagen', err);
      runInAction(() => {
        const current = this.projects.find((p) => p.id === projectId);
        if (current && previous !== null) {
          current.agentModel = previous;
        }
        this.error = toErrorMessage(err);
      });
      return false;
    }
  }

  /** Meldet das Verlassen der Chat-Page — die Grace-Period beginnt (R9). */
  async leaveProject(id: string): Promise<void> {
    try {
      await gqlRequest<{ leaveProject: boolean }>(LEAVE_PROJECT_MUTATION, { id });
    } catch (err) {
      // Beim Verlassen der Seite nicht mehr anzeigbar — aber nie verschlucken.
      console.error('ProjectsStore.leaveProject fehlgeschlagen', err);
    }
  }

  async deleteProject(id: string): Promise<boolean> {
    this.error = null;
    try {
      await gqlRequest<{ deleteProject: boolean }>(DELETE_PROJECT_MUTATION, { id });
      runInAction(() => {
        this.projects = this.projects.filter((p) => p.id !== id);
      });
      return true;
    } catch (err) {
      console.error('ProjectsStore.deleteProject fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
      });
      return false;
    }
  }
}
