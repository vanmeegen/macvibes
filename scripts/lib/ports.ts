/**
 * Die EINE Quelle für die Ports der Repo-Skripte (dev/preflight/doctor/shutdown).
 * Vorher kannten drei Dateien dieselben Defaults getrennt — dabei ist genau
 * der Fehler passiert, den diese Datei verhindert: preflight/shutdown lasen
 * `VITE_PORT`, das im Repo nirgends gesetzt wird, während dev.ts und
 * apps/web/vite.config.ts `MACVIBES_WEB_PORT` verwenden. Mit gesetztem
 * Override prüfte der Preflight dann den falschen Port und der Shutdown
 * ließ Vite als verwaisten Prozess weiterlaufen.
 */

/** Defaults, identisch zu vite.config.ts (web), Server-Config und Gateway. */
export const PORT_DEFAULTS = {
  web: 5173,
  server: 4000,
  egress: 4010,
  gateway: 4173,
} as const;

/** Dieselben Env-Overrides wie Server und Vite (CLAUDE.md, „Befehle"). */
export function portKonfiguration(): {
  web: number;
  server: number;
  egress: number;
  gateway: number;
} {
  return {
    web: Number(process.env['MACVIBES_WEB_PORT'] ?? PORT_DEFAULTS.web),
    server: Number(process.env['PORT'] ?? PORT_DEFAULTS.server),
    egress: Number(process.env['MACVIBES_EGRESS_PORT'] ?? PORT_DEFAULTS.egress),
    gateway: Number(process.env['MACVIBES_PREVIEW_GATEWAY_PORT'] ?? PORT_DEFAULTS.gateway),
  };
}

/**
 * Alle Ports einer laufenden macvibes-Instanz, in der Reihenfolge, in der
 * `shutdown` sie beendet (Web zuerst). Preflight, Doctor und Shutdown prüfen
 * damit DIESELBE Liste — vorher ließ der Preflight das Gateway aus.
 */
export function allePorts(): number[] {
  const ports = portKonfiguration();
  return [ports.web, ports.server, ports.egress, ports.gateway];
}
