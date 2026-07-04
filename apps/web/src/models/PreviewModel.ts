/** Zustände, die der Watchdog (PreviewSupervisor) im Backend meldet. */
export type PreviewStatus = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped';

export interface PreviewView {
  /** iframe anzeigen? Nur wenn der Dev-Server läuft und ein Port da ist. */
  showIframe: boolean;
  url: string | null;
  /** Fortschrittsbalken im Overlay (Start-/Neustartphase). */
  spinner: boolean;
  /** Nutzertext im Overlay. */
  message: string;
}

/**
 * Reine Ableitung der Preview-Darstellung aus dem autoritativen Backend-Status
 * (R7). Kein eigenes Polling mehr — der host-seitige Watchdog ist die Wahrheit;
 * das UI zeigt „Startet…"/„Wird neu gestartet…"/Fehler entsprechend an.
 */
export function derivePreviewView(
  status: PreviewStatus | string,
  host: string,
  hostPort: number | null,
): PreviewView {
  if (status === 'ready' && hostPort !== null) {
    return { showIframe: true, url: `http://${host}:${hostPort}/`, spinner: false, message: '' };
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
