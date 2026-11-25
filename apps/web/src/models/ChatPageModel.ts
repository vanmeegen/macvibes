import { makeAutoObservable, reaction, type IReactionDisposer } from 'mobx';
import type { Project } from '../api/types';
import type { ChatStore } from './ChatStore';
import { derivePreviewView, type PreviewView } from './previewView';
import { agentWorkingLabel } from './projectPresentation';
import type { ProjectsStore } from './ProjectsStore';

/** Adresse der App-Seite — Basis der Preview-URL (Host, http/https). */
export interface PageLocation {
  hostname: string;
  protocol: string;
}

function browserLocation(): PageLocation {
  return typeof window !== 'undefined'
    ? { hostname: window.location.hostname, protocol: window.location.protocol }
    : { hostname: 'localhost', protocol: 'http:' };
}

/** Der Ausschnitt des SpeechStore, den die Seite beim Öffnen braucht. */
interface SpeechInit {
  init(): void;
}

/** Status-Polling, solange die Chat-Seite offen ist (schneller als die Übersicht). */
const CHAT_POLL_INTERVAL_MS = 1000;

/**
 * Presentation Model der Chat-Seite: Lebenszyklus (Öffnen/Verlassen) und alles,
 * was die Seite aus Projektliste, Chat und Preview ableitet. Die Komponenten
 * rufen nur `open`/`close` und lesen die Ableitungen.
 */
export class ChatPageModel {
  /** Projekt-ID aus der Route — null, solange die Seite nicht offen ist. */
  routeProjectId: string | null = null;
  /** Chat-Spalte ausgeblendet → Preview nimmt das ganze Fenster ein. */
  chatCollapsed = false;
  /** Preview-Spalte ausgeblendet → Chat nimmt das ganze Fenster ein (Fokus/Phone). */
  previewCollapsed = false;
  /** Beobachtet, wann das Projekt der Route in der Liste auftaucht — nicht observable. */
  private disposeProjectReaction: IReactionDisposer | null = null;
  private stopProjectPolling: (() => void) | null = null;

  constructor(
    private readonly projectsStore: ProjectsStore,
    private readonly chatStore: ChatStore,
    private readonly speechStore: SpeechInit,
    private readonly pageLocation: () => PageLocation = browserLocation,
  ) {
    makeAutoObservable<
      this,
      | 'disposeProjectReaction'
      | 'stopProjectPolling'
      | 'projectsStore'
      | 'chatStore'
      | 'speechStore'
      | 'pageLocation'
    >(
      this,
      {
        disposeProjectReaction: false,
        stopProjectPolling: false,
        projectsStore: false,
        chatStore: false,
        speechStore: false,
        pageLocation: false,
      },
      { autoBind: true },
    );
  }

  /**
   * Seite betreten. Sobald das Projekt in der Liste steht (sofort oder nach dem
   * Laden), startet die Sandbox eager und der Chat verbindet sich.
   */
  open(routeProjectId: string): void {
    this.close();
    this.routeProjectId = routeProjectId;
    // Projektwechsel: beide Spalten sichtbar starten (kein „versteckter" Chat/Preview).
    this.chatCollapsed = false;
    this.previewCollapsed = false;
    // Ein Fehler der zuvor besuchten Seite gehört nicht über diesen Chat.
    this.projectsStore.clearError();
    // Grundvoraussetzungen fürs Diktat — bewusst nur synchrone Checks; die
    // echte available()-Probe passiert erst beim Klick (s. SpeechStore).
    this.speechStore.init();
    if (this.projectsStore.projects.length === 0 && !this.projectsStore.loading) {
      void this.projectsStore.load();
    }
    // Status live halten — auch für Nur-Lese-Besucher.
    this.stopProjectPolling = this.projectsStore.startPolling(CHAT_POLL_INTERVAL_MS);

    this.disposeProjectReaction = reaction(
      () => this.project?.id ?? null,
      (projectId) => {
        if (projectId === null) {
          // Projekt (noch) nicht in der Liste oder inzwischen gelöscht. `reset`
          // statt `disconnect`: sonst blieben „Agent arbeitet" und der
          // Stopp-Knopf eines gelöschten Projekts stehen.
          this.chatStore.reset();
          return;
        }
        // Eager-Start der Sandbox (Preview lädt, bevor die Subscription steht)
        // — auch für Nur-Lese-Besucher, sonst gäbe es bei fremden Projekten
        // keine Live-Preview (R10). Chatten bleibt Owner-only. KEIN leave beim
        // Verlassen (H11): der Betrachter-Refcount hängt an der chatEvents-
        // Subscription — ihr Ende sieht der Server auch bei Reload, Crash und
        // Netzabriss, eine Mutation nicht.
        // Ein Fehler, der erst eintrifft, wenn die Seite schon verlassen ist,
        // gehört nicht in die Übersicht.
        void this.projectsStore.enterProject(projectId, () => this.routeProjectId === projectId);
        // Chat-Historie + Live-Stream (alle angemeldeten Besucher, R10).
        void this.chatStore.connect(projectId);
      },
      { fireImmediately: true },
    );
  }

  /**
   * Seite verlassen. disconnect schließt die Subscription — serverseitig das
   * Signal, dass dieser Betrachter gegangen ist und die Grace-Period beginnen
   * darf (R9).
   */
  close(): void {
    if (this.routeProjectId === null) return;
    this.disposeProjectReaction?.();
    this.disposeProjectReaction = null;
    this.chatStore.disconnect();
    this.stopProjectPolling?.();
    this.stopProjectPolling = null;
    this.routeProjectId = null;
  }

  get project(): Project | null {
    const id = this.routeProjectId;
    return id === null ? null : (this.projectsStore.projects.find((p) => p.id === id) ?? null);
  }

  get isOwner(): boolean {
    const project = this.project;
    return project !== null && this.projectsStore.isOwn(project);
  }

  /** Fremdes Projekt: mitlesen ja, schreiben nein (R6/R10). */
  get readOnly(): boolean {
    return this.project !== null && !this.isOwner;
  }

  /** Modellwahl pro Chat — nur für den Owner und nur mit geladenem Katalog. */
  get showModelSelect(): boolean {
    return this.isOwner && this.projectsStore.agentModels.length > 0;
  }

  /** Hinweis „nicht gefunden" erst, wenn fertig geladen wurde und kein Fehler vorliegt. */
  get projectMissing(): boolean {
    return (
      this.routeProjectId !== null &&
      this.project === null &&
      !this.projectsStore.loading &&
      this.projectsStore.error === null
    );
  }

  /** Text der „Agent arbeitet"-Bubble, abhängig vom Sandbox-Status. */
  get workingLabel(): string {
    return agentWorkingLabel(this.project?.sandboxStatus ?? 'running');
  }

  /**
   * Live-Preview: aus dem autoritativen Status des Backends abgeleitet — kein
   * eigenes Polling (R7). Die iframe-URL zeigt aufs Preview-Gateway.
   */
  get preview(): PreviewView {
    const project = this.project;
    const location = this.pageLocation();
    return derivePreviewView(
      project?.previewStatus ?? 'stopped',
      location.hostname,
      project?.sandboxStatus === 'running' ? this.projectsStore.previewGatewayPort : null,
      project?.id ?? null,
      {
        // HTTPS-Seite (Caddy-Terminierung): iframe muss über den HTTPS-Port des
        // Gateways kommen, sonst blockt der Browser Mixed Content.
        pageProtocol: location.protocol,
        httpsGatewayPort: this.projectsStore.previewGatewayHttpsPort,
      },
    );
  }

  toggleChatCollapsed(): void {
    this.chatCollapsed = !this.chatCollapsed;
    // Wechselseitig exklusiv — nie beide Spalten gleichzeitig ausgeblendet
    // (sonst leerer Bildschirm).
    if (this.chatCollapsed) this.previewCollapsed = false;
  }

  togglePreviewCollapsed(): void {
    this.previewCollapsed = !this.previewCollapsed;
    if (this.previewCollapsed) this.chatCollapsed = false;
  }
}
