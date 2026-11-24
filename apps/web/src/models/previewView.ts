import type { PreviewStatus } from '../api/types';

interface PreviewView {
  /** iframe anzeigen? Nur wenn der Dev-Server läuft und der Gateway-Port da ist. */
  showIframe: boolean;
  url: string | null;
  /** Fortschrittsbalken im Overlay (Start-/Neustartphase). */
  spinner: boolean;
  /** Nutzertext im Overlay. */
  message: string;
}

/** Protokoll-Kontext der aufrufenden Seite (HTTPS-Terminierung via Caddy). */
interface PreviewProtocolOptions {
  /** window.location.protocol der App-Seite ('http:' | 'https:'). */
  pageProtocol: string;
  /** HTTPS-Port des Preview-Gateways (Caddy-Terminierung) — null wenn keiner. */
  httpsGatewayPort: number | null;
}

/** Overlay statt iframe: Nutzertext, in Start-/Neustartphasen mit Fortschrittsbalken. */
function overlay(message: string, spinner = false): PreviewView {
  return { showIframe: false, url: null, spinner, message };
}

/**
 * Reine Ableitung der Preview-Darstellung aus dem autoritativen Backend-Status
 * (R7). Die iframe-URL zeigt auf das **Preview-Gateway** (fester Port) mit
 * `/p/<projectId>/`, NICHT auf den dynamischen VM-Port — nur so ist die Preview
 * über Remote/VPN erreichbar (nur der Gateway-Port wird geforwardet). Das
 * Gateway routet über Referer/Cookie zur richtigen VM.
 */
export function derivePreviewView(
  status: PreviewStatus,
  host: string,
  gatewayPort: number | null,
  projectId: string | null,
  protocol: PreviewProtocolOptions = { pageProtocol: 'http:', httpsGatewayPort: null },
): PreviewView {
  if (status === 'ready' && gatewayPort !== null && projectId !== null) {
    // HTTPS-Seite: der Browser blockt ein http-iframe als Mixed Content — die
    // Preview muss über den HTTPS-Port des Gateways (Caddy) kommen.
    const https = protocol.pageProtocol === 'https:';
    const port = https ? protocol.httpsGatewayPort : gatewayPort;
    if (port === null) {
      return overlay(
        'Preview über HTTPS braucht MACVIBES_PREVIEW_GATEWAY_HTTPS_PORT ' +
          '(TLS-Terminierung, s. CLAUDE.md).',
      );
    }
    return {
      showIframe: true,
      url: `${https ? 'https' : 'http'}://${host}:${port}/p/${encodeURIComponent(projectId)}/`,
      spinner: false,
      message: '',
    };
  }
  switch (status) {
    case 'starting':
      return overlay('Preview startet …', true);
    case 'restarting':
      return overlay('Preview wird neu gestartet …', true);
    case 'failed':
      return overlay('Preview konnte nicht gestartet werden — bitte das Projekt neu öffnen.');
    case 'ready':
    case 'stopped':
      // 'ready' landet nur hier, wenn Gateway-Port oder Projekt fehlen.
      return overlay('Preview nicht verfügbar — Sandbox gestoppt.');
  }
  // Laufzeit-Netz: ein Status, den dieses Bundle noch nicht kennt.
  const unknown: never = status;
  console.warn('Unbekannter Preview-Status vom Server', unknown);
  return overlay('Preview nicht verfügbar — Sandbox gestoppt.');
}
