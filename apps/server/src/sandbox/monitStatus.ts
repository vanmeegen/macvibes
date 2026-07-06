import type { PreviewStatus } from './provider';

/**
 * Übersetzt die monit-Status-Ausgabe (`GET /_status?format=text` der
 * monit-HTTP-API) in unseren PreviewStatus. Bewusst tolerant geparst —
 * maßgeblich ist die `status`-Zeile im Abschnitt des gesuchten Services.
 */
export function previewStatusFromMonitText(text: string, service = 'devserver'): PreviewStatus {
  const status = serviceStatusLine(text, service);
  if (status === null) return 'starting';

  const normalized = status.toLowerCase();
  // Reihenfolge zählt: "Not monitored" enthält kein "running", aber
  // "Restart pending" muss vor einem generischen Treffer stehen.
  if (normalized.includes('not monitored') || normalized.includes('unmonitor')) return 'failed';
  if (
    normalized.includes('restart') ||
    normalized.includes('does not exist') ||
    normalized.includes('execution failed')
  ) {
    return 'restarting';
  }
  if (normalized.includes('initializing')) return 'starting';
  if (normalized.includes('running') || normalized === 'ok' || normalized.startsWith('ok ')) {
    return 'ready';
  }
  return 'starting';
}

/** Findet die status-Zeile im Abschnitt `Process '<service>'`. */
function serviceStatusLine(text: string, service: string): string | null {
  const lines = text.split('\n');
  let inSection = false;
  for (const line of lines) {
    const sectionMatch = line.match(/^\w[\w ]*'(.+)'\s*$/);
    if (sectionMatch !== null) {
      inSection = sectionMatch[1] === service;
      continue;
    }
    if (!inSection) continue;
    const statusMatch = line.match(/^\s+status\s{2,}(.+?)\s*$/);
    if (statusMatch !== null && statusMatch[1] !== undefined) {
      return statusMatch[1];
    }
  }
  return null;
}
