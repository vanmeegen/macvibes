/**
 * Auflösung des LiteLLM-Config-Pfads für den lokalen Router (run.ts).
 *
 * WARUM ein eigener Mechanismus: die mitgelieferte `litellm_config.yaml` liegt
 * bei einer Installation (Homebrew) in `<libexec>` — dieser Baum wird bei JEDEM
 * `brew upgrade` ersetzt, dort editierte Konfiguration wäre nach dem nächsten
 * Update weg. Nutzereigene Router-Config gehört deshalb ins upgrade-feste
 * `<macvibesHome>` (Default `~/macvibes`). Vorrang:
 *
 *   1) MACVIBES_LOCAL_ROUTER_CONFIG      — explizit gewählte Datei
 *   2) <macvibesHome>/litellm.yaml       — falls vorhanden
 *   3) mitgelieferte litellm_config.yaml — Rückwärtskompatibilität (Bestand
 *      ohne Home-Datei läuft unverändert weiter)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface RouterConfigPathOptions {
  /** MACVIBES_LOCAL_ROUTER_CONFIG (explizit gewählte Datei) oder undefined. */
  envPath: string | undefined;
  /** <macvibesHome> (Default ~/macvibes) — Ort der nutzereigenen litellm.yaml. */
  macvibesHome: string;
  /** Verzeichnis der mitgelieferten litellm_config.yaml (local-router/). */
  bundledDir: string;
  /** Test-Naht; Default existsSync. */
  exists?: (path: string) => boolean;
}

export function resolveRouterConfigPath(options: RouterConfigPathOptions): string {
  const exists = options.exists ?? existsSync;
  // Explizit gesetzt gewinnt IMMER — auch wenn die Datei (noch) fehlt: dann
  // soll LiteLLM laut mit genau diesem Pfad scheitern, nicht leise eine
  // andere Config nehmen.
  if (options.envPath !== undefined && options.envPath !== '') return options.envPath;
  const homeConfig = join(options.macvibesHome, 'litellm.yaml');
  if (exists(homeConfig)) return homeConfig;
  return join(options.bundledDir, 'litellm_config.yaml');
}
