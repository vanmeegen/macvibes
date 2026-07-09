import { describe, expect, test } from 'bun:test';
import { buildVmAgentEnv } from '../vmAgentEnv';
import { AGENT_CONFIG_GUEST_DIR } from '../../sandbox/microsandboxProvider';

// Jede Assertion sichert die Reparatur eines im Systemtest gefundenen Bugs ab.
// Credentials + Egress laufen NICHT mehr über Host-Proxys: msb injiziert den
// Token als Secret (Platzhalter in der VM, Substitution am Egress) und die
// Domain-Netzregeln erlauben direkten Public-Zugriff (msb ≥ 0.6.2).
describe('buildVmAgentEnv — kritische Agent-Umgebung', () => {
  const env = buildVmAgentEnv();

  test('IS_SANDBOX=1 — sonst bricht bypassPermissions als root ab (Bug 2026-07-04)', () => {
    expect(env.IS_SANDBOX).toBe('1');
  });

  test('CLAUDE_CONFIG_DIR zeigt auf das persistente Volume — sonst scheitert --resume nach VM-Neustart', () => {
    expect(env.CLAUDE_CONFIG_DIR).toBe(AGENT_CONFIG_GUEST_DIR);
  });

  test('KEINE Proxy-/Credential-Variablen mehr — der Token kommt als msb-Secret', () => {
    // Der echte Token ist nie in der VM; msb setzt ihn erst am Egress zu
    // api.anthropic.com ein. BASE_URL bleibt Default, kein HTTP(S)_PROXY.
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});
