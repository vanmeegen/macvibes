import type { SandboxStatus } from '../api/types';

/** Formatiert einen Server-Zeitstempel (ISO-String) deutsch. */
export function formatTimestamp(value: string): string {
  const millis = Date.parse(value);
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
export function agentWorkingLabel(sandboxStatus: SandboxStatus): string {
  switch (sandboxStatus) {
    case 'starting':
      return 'MicroVM startet — Workspace wird vorbereitet …';
    case 'stopped':
    case 'stopping':
      return 'Sandbox wird gestartet …';
    case 'running':
      return 'Agent arbeitet …';
  }
  return unknownStatus(sandboxStatus, 'Agent arbeitet …');
}

/**
 * Status-Chip der Projektkarte: ein laufender Agent-Turn („arbeitet") hat
 * Vorrang vor dem Sandbox-Status — gerade langlaufende Turns (lokale Modelle,
 * Grace-Verlängerung) sind sonst von außen unsichtbar.
 */
export function projectStatusChip(
  sandboxStatus: SandboxStatus,
  turnActive: boolean,
): { label: string; color: 'success' | 'warning' | 'default' } {
  if (turnActive) return { label: 'arbeitet', color: 'warning' };
  return {
    label: sandboxStatusLabel(sandboxStatus),
    color: sandboxStatus === 'running' ? 'success' : 'default',
  };
}

/** Deutsche Anzeige des Sandbox-Status. */
function sandboxStatusLabel(status: SandboxStatus): string {
  switch (status) {
    case 'running':
      // „bereit" statt „läuft": klare Abgrenzung zum Turn-Status „arbeitet".
      return 'bereit';
    case 'starting':
      return 'startet';
    case 'stopping':
      return 'stoppt';
    case 'stopped':
      return 'gestoppt';
  }
  return unknownStatus(status, String(status));
}

/**
 * Laufzeit-Netz für einen Status, den der Typ nicht kennt (Server neuer als
 * das Web-Bundle). Der `never`-Parameter erzwingt zur Compile-Zeit, dass jeder
 * bekannte Status oben einen eigenen Zweig hat.
 */
function unknownStatus(status: never, fallback: string): string {
  console.warn('Unbekannter Sandbox-Status vom Server', status);
  return fallback;
}
