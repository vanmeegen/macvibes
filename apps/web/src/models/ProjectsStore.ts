import { makeAutoObservable, runInAction } from 'mobx';
import { toErrorMessage } from '../api/errors';
import { gqlRequest } from '../api/graphqlClient';
import type { AgentModelInfo, Project, Template } from '../api/types';
import { NameDialogModel } from './NameDialogModel';
import type { AuthStore } from './AuthStore';

export type ProjectFilter = 'mine' | 'all';

export const PROJECT_FILTER_STORAGE_KEY = 'macvibes.projectFilter';

// Die vollständige Feldauswahl eines Projekts — von der Listen-Query UND vom
// copyProject-Ergebnis gebraucht. Als EINE Quelle, damit die beiden nicht
// auseinanderdriften (ein hier ergänztes Feld fehlte sonst nach dem Kopieren).
// Kein echtes GraphQL-Fragment, nur Textbaustein: der handgepflegte Client
// (api/types.ts) kennt keinen Codegen, der Fragmente auflösen würde.
const PROJECT_FIELDS = /* GraphQL */ `
  id
  name
  templateDir
  owner {
    id
    username
  }
  agentModel
  lastActivityAt
  sandboxStatus
  turnActive
  previewStatus
`;

const PROJECTS_AND_TEMPLATES_QUERY = /* GraphQL */ `
  query ProjectsAndTemplates {
    previewGatewayPort
    previewGatewayHttpsPort
    projects {
      ${PROJECT_FIELDS}
    }
    agentModels {
      id
      label
    }
    templates {
      name
      description
      dir
    }
  }
`;

const DELETE_PROJECT_MUTATION = /* GraphQL */ `
  mutation DeleteProject($id: ID!) {
    deleteProject(id: $id)
  }
`;

const COPY_PROJECT_MUTATION = /* GraphQL */ `
  mutation CopyProject($sourceId: ID!, $name: String!) {
    copyProject(sourceId: $sourceId, name: $name) {
      ${PROJECT_FIELDS}
    }
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

const SET_PROJECT_MODEL_MUTATION = /* GraphQL */ `
  mutation SetProjectModel($projectId: ID!, $model: String!) {
    setProjectModel(projectId: $projectId, model: $model) {
      id
      agentModel
    }
  }
`;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Übernimmt `incoming`, behält aber inhaltsgleiche Einträge als DIESELBEN
 * Objekte — und die Liste selbst, wenn sich gar nichts geändert hat. So
 * rendert nach einem Poll-Tick nur neu, was sich wirklich geändert hat.
 */
function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  let changed = current.length !== incoming.length;
  const merged = incoming.map((item, index) => {
    const existing = byId.get(item.id);
    if (existing === undefined || !sameJson(existing, item)) {
      changed = true;
      return item;
    }
    if (current[index] !== existing) changed = true;
    return existing;
  });
  return changed ? merged : current;
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

/**
 * Status-Chip der Projektkarte: ein laufender Agent-Turn („arbeitet") hat
 * Vorrang vor dem Sandbox-Status — gerade langlaufende Turns (lokale Modelle,
 * Grace-Verlängerung) sind sonst von außen unsichtbar.
 */
export function projectStatusChip(
  sandboxStatus: string,
  turnActive: boolean,
): { label: string; color: 'success' | 'warning' | 'default' } {
  if (turnActive) return { label: 'arbeitet', color: 'warning' };
  return {
    label: sandboxStatusLabel(sandboxStatus),
    color: sandboxStatus === 'running' ? 'success' : 'default',
  };
}

/** Deutsche Anzeige des Sandbox-Status. */
function sandboxStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      // „bereit" statt „läuft": klare Abgrenzung zum Turn-Status „arbeitet".
      return 'bereit';
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
  /** HTTPS-Port des Gateways (Caddy-Terminierung) — null ohne TLS. */
  previewGatewayHttpsPort: number | null = null;
  filter: ProjectFilter = readFilterFromStorage();
  error: string | null = null;
  loading = false;
  /** Projekt-ID, für die gerade der Lösch-Bestätigungsdialog offen ist. */
  pendingDeleteId: string | null = null;
  /** Kopieren-Dialog (Name vorgefüllt mit „<Name> Kopie"). */
  readonly copyDialog = new NameDialogModel('ProjectsStore.confirmCopy');
  /** Umbenennen-Dialog (Name vorgefüllt mit dem aktuellen Namen). */
  readonly renameDialog = new NameDialogModel('ProjectsStore.confirmRename');
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

  private projectById(id: string | null): Project | null {
    return id === null ? null : (this.projects.find((p) => p.id === id) ?? null);
  }

  get pendingCopyProject(): Project | null {
    return this.projectById(this.copyDialog.projectId);
  }

  requestCopy(id: string): void {
    const project = this.projectById(id);
    this.copyDialog.open(id, project ? `${project.name} Kopie` : '');
  }

  /**
   * „Kopieren und Anpassen": legt den Fork an und liefert die neue Projekt-ID
   * (für die Navigation in den Chat). Bei Server-Fehler (z. B. doppelter Name)
   * bleibt der Dialog offen.
   */
  confirmCopy(): Promise<string | null> {
    return this.copyDialog.confirm(async (sourceId, name) => {
      const data = await gqlRequest<{ copyProject: Project }>(COPY_PROJECT_MUTATION, {
        sourceId,
        name,
      });
      runInAction(() => {
        this.projects = [data.copyProject, ...this.projects];
      });
      return data.copyProject.id;
    });
  }

  get pendingRenameProject(): Project | null {
    return this.projectById(this.renameDialog.projectId);
  }

  requestRename(id: string): void {
    this.renameDialog.open(id, this.projectById(id)?.name ?? '');
  }

  /**
   * Benennt das vorgemerkte Projekt um. Bei Server-Fehler (z. B. doppelter
   * Name) bleibt der Dialog offen, damit der Name korrigiert werden kann.
   */
  async confirmRename(): Promise<boolean> {
    const renamed = await this.renameDialog.confirm(async (id, name) => {
      const data = await gqlRequest<{ renameProject: { id: string; name: string } }>(
        RENAME_PROJECT_MUTATION,
        { id, name },
      );
      runInAction(() => {
        const project = this.projects.find((p) => p.id === id);
        if (project) {
          project.name = data.renameProject.name;
        }
      });
      return true;
    });
    return renamed ?? false;
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
      await this.fetchInto();
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
      await this.fetchInto();
    } catch (err) {
      // Bewusst KEIN this.error: das Polling läuft im Hintergrund, ein einzelner
      // Fehlschlag darf nicht die ganze Seite mit einer Fehlermeldung überziehen.
      console.error('ProjectsStore.refresh fehlgeschlagen', err);
    }
  }

  /**
   * Die eigentliche Abfrage — geteilt von `load` (mit Spinner und sichtbarem
   * Fehler) und `refresh` (still). Vorher war `refresh` eine wörtliche Kopie
   * von `load`: dieselbe Query, dieselbe Ergebniszuweisung, nur ohne die beiden
   * Zustandsflags. Jede Feldänderung musste an zwei Stellen nachgezogen werden.
   */
  private async fetchInto(): Promise<void> {
    const data = await gqlRequest<{
      projects: Project[];
      templates: Template[];
      previewGatewayPort: number;
      previewGatewayHttpsPort: number | null;
      agentModels: AgentModelInfo[];
    }>(PROJECTS_AND_TEMPLATES_QUERY);
    runInAction(() => {
      // Das Polling liefert meist inhaltsgleiche Antworten. Würden sie blind
      // zugewiesen, entstünden bei jedem Tick neue Objekte — und jede Karte
      // bzw. die ganze Chat-Seite renderte neu, obwohl sich nichts geändert hat.
      this.projects = mergeById(this.projects, data.projects);
      if (!sameJson(this.templates, data.templates)) this.templates = data.templates;
      if (!sameJson(this.agentModels, data.agentModels)) this.agentModels = data.agentModels;
      this.previewGatewayPort = data.previewGatewayPort;
      this.previewGatewayHttpsPort = data.previewGatewayHttpsPort;
    });
  }

  /**
   * Hält den Status per Polling aktuell — aber nur im sichtbaren Tab: ein
   * versteckter Tab fragt nicht ab und holt den Stand nach, sobald er wieder
   * sichtbar wird.
   */
  startPolling(intervalMs = 2000): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => {
      if (!document.hidden) void this.refresh();
    }, intervalMs);
    document.addEventListener('visibilitychange', this.refreshWhenVisible);
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      document.removeEventListener('visibilitychange', this.refreshWhenVisible);
    }
  }

  private refreshWhenVisible(): void {
    if (!document.hidden) void this.refresh();
  }

  /**
   * Eager-Start der Sandbox beim Öffnen der Chat-Page (auch für Besucher, R10)
   * — die Preview lädt so schon, bevor die chatEvents-Subscription steht.
   * Kein Gegenstück zum Verlassen (H11): der Betrachter-Refcount des Servers
   * hängt an der Lebensdauer der Subscription (ChatStore.connect/disconnect);
   * ihr Ende — auch bei Reload, Crash oder Netzabriss — meldet den Betrachter
   * serverseitig ab.
   */
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
