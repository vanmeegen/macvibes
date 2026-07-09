import { AGENT_CONFIG_GUEST_DIR } from '../sandbox/microsandboxProvider';

/**
 * Baut die Umgebung für Claude Code in der MicroVM. Reine Funktion, damit die
 * sicherheits-/funktionskritischen Variablen deterministisch getestet werden —
 * jede hier ist die Reparatur eines im Systemtest gefundenen Bugs:
 * - IS_SANDBOX: erlaubt bypassPermissions als root in der VM (sonst bricht
 *   Claude Code mit "cannot be used with root" ab).
 * - CLAUDE_CONFIG_DIR: Sessiondaten aufs persistente Volume — sonst geht die
 *   Session bei jedem VM-Neustart verloren und `--resume` scheitert (R9).
 *
 * Credentials sind hier bewusst NICHT dabei: der Token wird als msb-Secret
 * injiziert (`--secret CLAUDE_CODE_OAUTH_TOKEN=…@api.anthropic.com`) — die VM
 * sieht nur einen Platzhalter, msb setzt den echten Wert erst host-seitig am
 * Egress ein. Auch kein HTTP(S)_PROXY mehr: die Domain-Netzregeln von
 * msb ≥ 0.6.2 erlauben direkten Public-Egress (der alte Egress-Proxy-Workaround
 * für den Regel-Bug von 2026-07-05 ist damit hinfällig).
 */
export function buildVmAgentEnv(): Record<string, string> {
  return {
    IS_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: AGENT_CONFIG_GUEST_DIR,
  };
}
