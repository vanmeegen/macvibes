/** Zustände, die der Watchdog (PreviewSupervisor) im Backend meldet. */
export type PreviewStatus = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped';

export interface PreviewView {
  /** iframe anzeigen? Nur wenn der Dev-Server läuft und der Gateway-Port da ist. */
  showIframe: boolean;
  url: string | null;
  /** Fortschrittsbalken im Overlay (Start-/Neustartphase). */
  spinner: boolean;
  /** Nutzertext im Overlay. */
  message: string;
}

/**
 * Reine Ableitung der Preview-Darstellung aus dem autoritativen Backend-Status
 * (R7). Die iframe-URL zeigt auf das **Preview-Gateway** (fester Port) mit
 * `/p/<projectId>/`, NICHT auf den dynamischen VM-Port — nur so ist die Preview
 * über Remote/VPN erreichbar (nur der Gateway-Port wird geforwardet). Das
 * Gateway routet über Referer/Cookie zur richtigen VM.
 */
export function derivePreviewView(
  status: PreviewStatus | string,
  host: string,
  gatewayPort: number | null,
  projectId: string | null,
): PreviewView {
  if (status === 'ready' && gatewayPort !== null && projectId !== null) {
    return {
      showIframe: true,
      url: `http://${host}:${gatewayPort}/p/${encodeURIComponent(projectId)}/`,
      spinner: false,
      message: '',
    };
  }
  switch (status) {
    case 'starting':
      return { showIframe: false, url: null, spinner: true, message: 'Preview startet …' };
    case 'restarting':
      return {
        showIframe: false,
        url: null,
        spinner: true,
        message: 'Preview wird neu gestartet …',
      };
    case 'failed':
      return {
        showIframe: false,
        url: null,
        spinner: false,
        message: 'Preview konnte nicht gestartet werden — bitte das Projekt neu öffnen.',
      };
    default:
      return {
        showIframe: false,
        url: null,
        spinner: false,
        message: 'Preview nicht verfügbar — Sandbox gestoppt.',
      };
  }
}
