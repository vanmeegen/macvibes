import { makeAutoObservable, runInAction } from 'mobx';
import { toErrorMessage } from '../api/errors';
import { gqlRequest } from '../api/graphqlClient';
import type { AgentModelInfo, Project, Template } from '../api/types';
import { NameDialogModel } from './NameDialogModel';
import type { AuthStore } from './AuthStore';
import { browserStorage, readSetting, writeSetting } from './safeStorage';

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
  const stored = readSetting(browserStorage(), PROJECT_FILTER_STORAGE_KEY);
  return stored === 'mine' || stored === 'all' ? stored : 'mine';
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
    writeSetting(browserStorage(), PROJECT_FILTER_STORAGE_KEY, filter);
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

  /**
   * Stammt `error` aus dem Laden oder Betreten (nicht aus einer Nutzeraktion)?
   * Dann löscht ihn der nächste erfolgreiche Abruf.
   */
  private fehlerHeiltVonSelbst = false;

  /** Lädt Projekte und Templates in einem Request. */
  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.fehlerHeiltVonSelbst = false;
    try {
      await this.fetchProjects();
    } catch (err) {
      console.error('ProjectsStore.load fehlgeschlagen', err);
      runInAction(() => {
        this.error = toErrorMessage(err);
        this.fehlerHeiltVonSelbst = true;
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
      await this.fetchProjects();
      // Ein Fehler aus einem früheren Laden/Betreten ist mit frischen Daten
      // überholt — ohne das klebte das Banner, bis die Seite neu geladen wird.
      if (this.fehlerHeiltVonSelbst) {
        runInAction(() => {
          this.error = null;
          this.fehlerHeiltVonSelbst = false;
          this.fehlerHeiltVonSelbst = false;
        });
      }
    } catch (err) {
      // Bewusst KEIN this.error: das Polling läuft im Hintergrund, ein einzelner
      // Fehlschlag darf nicht die ganze Seite mit einer Fehlermeldung überziehen.
      console.error('ProjectsStore.refresh fehlgeschlagen', err);
    }
  }

  /**
   * Die eigentliche Abfrage — geteilt von `load` (mit Spinner und sichtbarem
   * Fehler) und `refresh` (still).
   */
  private async fetchProjects(): Promise<void> {
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
   * sichtbar wird. Liefert die Funktion zurück, die genau dieses Polling
   * wieder beendet.
   */
  startPolling(intervalMs = 2000): () => void {
    // Ein laufendes Polling wird ERSETZT, nicht behalten: Übersicht und
    // Chat-Seite wollen verschiedene Intervalle, und ein stilles „läuft schon"
    // ließe beim Seitenwechsel das alte Intervall weiterlaufen.
    this.stopPolling();
    const timer = setInterval(() => {
      if (!document.hidden) void this.refresh();
    }, intervalMs);
    this.pollTimer = timer;
    document.addEventListener('visibilitychange', this.refreshWhenVisible);
    // Der Aufrufer stoppt nur SEIN Polling: React räumt die verlassene Seite
    // (passiver Effekt) erst auf, nachdem die neue ihr Polling schon gestartet
    // hat (Layout-Effekt) — ein pauschales Stoppen beendete dann das neue.
    return () => {
      if (this.pollTimer === timer) this.stopPolling();
    };
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
  async enterProject(id: string, nochRelevant: () => boolean = () => true): Promise<void> {
    this.error = null;
    this.fehlerHeiltVonSelbst = false;
    try {
      await gqlRequest<{ enterProject: { id: string } }>(ENTER_PROJECT_MUTATION, { id });
      await this.refresh();
    } catch (err) {
      console.error('ProjectsStore.enterProject fehlgeschlagen', err);
      // Die Seite ist inzwischen verlassen: der Fehler gehört nirgends mehr hin.
      if (!nochRelevant()) return;
      runInAction(() => {
        this.error = toErrorMessage(err);
        this.fehlerHeiltVonSelbst = true;
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
    this.error = null;
    this.fehlerHeiltVonSelbst = false;
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

  /** Verwirft die Fehlermeldung — z. B. beim Betreten einer anderen Seite. */
  clearError(): void {
    this.error = null;
    this.fehlerHeiltVonSelbst = false;
  }

  async deleteProject(id: string): Promise<boolean> {
    this.error = null;
    this.fehlerHeiltVonSelbst = false;
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
