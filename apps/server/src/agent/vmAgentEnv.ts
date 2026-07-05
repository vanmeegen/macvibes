import { PROXY_TOKEN_HEADER } from '../http/anthropicProxy';
import { AGENT_CONFIG_GUEST_DIR } from '../sandbox/microsandboxProvider';

export interface VmAgentEnvParams {
  /** Port des macvibes-Servers (Host-Proxy). */
  serverPort: number;
  /** Shared Secret VM → Credential-Proxy (auch Basic-Auth des Egress-Proxys). */
  proxyToken: string;
  /** Port des Egress-Proxys (CONNECT) auf dem Host. */
  egressPort: number;
}

/**
 * Baut die Umgebung für Claude Code in der MicroVM. Reine Funktion, damit die
 * sicherheits-/funktionskritischen Variablen deterministisch getestet werden —
 * jede hier ist die Reparatur eines im Systemtest gefundenen Bugs:
 * - ANTHROPIC_BASE_URL / ANTHROPIC_CUSTOM_HEADERS / ANTHROPIC_API_KEY:
 *   Credentials nur über den Host-Proxy (die VM sieht nie einen echten Token).
 * - IS_SANDBOX: erlaubt bypassPermissions als root in der VM (sonst bricht
 *   Claude Code mit "cannot be used with root" ab).
 * - CLAUDE_CONFIG_DIR: Sessiondaten aufs persistente Volume — sonst geht die
 *   Session bei jedem VM-Neustart verloren und `--resume` scheitert (R9).
 * - HTTP(S)_PROXY: msb blockt mit gesetzten net-rules JEDEN Public-Egress
 *   (Bug, 2026-07-05) — claudes Startup hing dadurch ~180s in Connect-
 *   Timeouts. Aller Nicht-API-Traffic läuft deshalb über den Egress-Proxy
 *   auf dem Host; NO_PROXY hält den Credential-Proxy-Pfad direkt.
 */
export function buildVmAgentEnv(params: VmAgentEnvParams): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `http://host.microsandbox.internal:${params.serverPort}/anthropic`,
    ANTHROPIC_CUSTOM_HEADERS: `${PROXY_TOKEN_HEADER}: ${params.proxyToken}`,
    ANTHROPIC_API_KEY: 'macvibes-proxy',
    IS_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: AGENT_CONFIG_GUEST_DIR,
    HTTP_PROXY: `http://mv:${params.proxyToken}@host.microsandbox.internal:${params.egressPort}`,
    HTTPS_PROXY: `http://mv:${params.proxyToken}@host.microsandbox.internal:${params.egressPort}`,
    NO_PROXY: 'host.microsandbox.internal,localhost,127.0.0.1',
  };
}
