import { describe, expect, test } from 'bun:test';
import { buildVmAgentEnv } from '../vmAgentEnv';
import { PROXY_TOKEN_HEADER } from '../../http/anthropicProxy';
import { AGENT_CONFIG_GUEST_DIR } from '../../sandbox/microsandboxProvider';

// Jede Assertion sichert die Reparatur eines im Systemtest gefundenen Bugs ab.
describe('buildVmAgentEnv — kritische Agent-Umgebung', () => {
  const env = buildVmAgentEnv({ serverPort: 4000, proxyToken: 'secret-xyz' });

  test('API läuft über den Host-Proxy (Credentials nie in der VM)', () => {
    expect(env.ANTHROPIC_BASE_URL).toBe('http://host.microsandbox.internal:4000/anthropic');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`${PROXY_TOKEN_HEADER}: secret-xyz`);
    // Nur ein Platzhalter — der echte Token wird erst im Proxy eingesetzt.
    expect(env.ANTHROPIC_API_KEY).toBe('macvibes-proxy');
  });

  test('IS_SANDBOX=1 — sonst bricht bypassPermissions als root ab (Bug 2026-07-04)', () => {
    expect(env.IS_SANDBOX).toBe('1');
  });

  test('CLAUDE_CONFIG_DIR zeigt auf das persistente Volume — sonst scheitert --resume nach VM-Neustart', () => {
    expect(env.CLAUDE_CONFIG_DIR).toBe(AGENT_CONFIG_GUEST_DIR);
  });

  test('der Proxy-Token wandert in den Custom-Header, nicht in ANTHROPIC_API_KEY', () => {
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toContain('secret-xyz');
    expect(env.ANTHROPIC_API_KEY).not.toContain('secret-xyz');
  });
});
