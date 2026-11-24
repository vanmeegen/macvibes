import { describe, expect, test } from 'bun:test';
import { buildVmAgentEnv, buildVmDaemonEnv } from '../vmAgentEnv';
import { AGENT_CONFIG_GUEST_DIR, PROXY_TOKEN_HEADER } from '../../core/vmContract';
// Test darf über Schichtgrenzen greifen (s. eslint.config.js): hier wird die
// PRODUKTIONS-Verdrahtung gepinnt — msb-Alias injiziert wie in index.ts.
import { MSB_HOST_ALIAS } from '../../sandbox/microsandboxProvider';

// Jede Assertion sichert die Reparatur eines im Systemtest gefundenen Bugs ab.
describe('buildVmAgentEnv — kritische Agent-Umgebung', () => {
  const env = buildVmAgentEnv({
    serverPort: 4000,
    proxyToken: 'secret-xyz',
    egressPort: 4010,
    hostAlias: MSB_HOST_ALIAS,
  });

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

  test('aller übriger Traffic läuft über den Host-Egress-Proxy (msb-Regeln blocken Public)', () => {
    // claudes Startup (Telemetrie/Updates) hing sonst ~180s in Connect-Timeouts,
    // weil msb mit gesetzten net-rules JEDEN Public-Egress blockt (Bug, 2026-07-05).
    expect(env.HTTP_PROXY).toBe('http://mv:secret-xyz@host.microsandbox.internal:4010');
    expect(env.HTTPS_PROXY).toBe('http://mv:secret-xyz@host.microsandbox.internal:4010');
    // Der Credential-Proxy (API) bleibt DIREKT über den Gateway — nicht doppelt proxien.
    expect(env.NO_PROXY).toContain('host.microsandbox.internal');
  });

  test('der Host-Alias ist injiziert, nicht hartkodiert (Backend-Wechsel: M4)', () => {
    // Ein anderes VM-Backend (Windows-Stufe 2) erreicht den Host anders als
    // über msb-NAT — der Alias muss deshalb VOLLSTÄNDIG durchfließen. Bliebe
    // irgendwo ein hartkodiertes host.microsandbox.internal stehen, zeigte
    // API-, Egress- oder NO_PROXY-Pfad beim Backend-Wechsel still ins Leere.
    const fremd = buildVmAgentEnv({
      serverPort: 4000,
      proxyToken: 'secret-xyz',
      egressPort: 4010,
      hostAlias: 'host.anderes-backend.test',
    });
    for (const wert of Object.values(fremd)) {
      expect(wert).not.toContain('host.microsandbox.internal');
    }
    expect(fremd.ANTHROPIC_BASE_URL).toBe('http://host.anderes-backend.test:4000/anthropic');
    expect(fremd.HTTPS_PROXY).toBe('http://mv:secret-xyz@host.anderes-backend.test:4010');
    expect(fremd.NO_PROXY).toContain('host.anderes-backend.test');
  });

  test('eine konfigurierte Zusatz-Anweisung erreicht den VM-Daemon (MACVIBES_AGENT_APPEND_PROMPT)', () => {
    // Der Daemon liest die Variable in der VM — gesetzt hat sie aber niemand:
    // die Übersteuerung wirkte nur im Host-Runner (Dev), nie im Produktivpfad.
    const mit = buildVmAgentEnv({
      serverPort: 4000,
      proxyToken: 'secret-xyz',
      egressPort: 4010,
      hostAlias: MSB_HOST_ALIAS,
      appendSystemPrompt: "Handle sofort.\nKeine 'Ankündigungen'.",
    });
    expect(mit.MACVIBES_AGENT_APPEND_PROMPT).toBe("Handle sofort.\nKeine 'Ankündigungen'.");
  });

  test('ohne Übersteuerung bleibt die Variable weg — der Daemon nimmt dann seinen Default', () => {
    expect('MACVIBES_AGENT_APPEND_PROMPT' in env).toBe(false);
    const explizitNull = buildVmAgentEnv({
      serverPort: 4000,
      proxyToken: 'secret-xyz',
      egressPort: 4010,
      hostAlias: MSB_HOST_ALIAS,
      appendSystemPrompt: null,
    });
    expect('MACVIBES_AGENT_APPEND_PROMPT' in explizitNull).toBe(false);
  });
});

describe('buildVmDaemonEnv — Daemon wählt sich ins Host-Gateway ein', () => {
  test('Gateway-URL trägt Alias, Port, Sandbox-Namen und Token (URL-kodiert)', () => {
    const env = buildVmDaemonEnv({
      serverPort: 4000,
      proxyToken: 'tok/en+1',
      egressPort: 4010,
      hostAlias: MSB_HOST_ALIAS,
      sandboxName: 'macvibes-projekt 1',
    });
    expect(env.MACVIBES_AGENT_GATEWAY_URL).toBe(
      'ws://host.microsandbox.internal:4000/agent?sandbox=macvibes-projekt%201&token=tok%2Fen%2B1',
    );
    // Die Claude-Umgebung bleibt vollständig enthalten.
    expect(env.ANTHROPIC_BASE_URL).toBe('http://host.microsandbox.internal:4000/anthropic');
    // Das Arbeitsverzeichnis kommt aus dem Host↔VM-Vertrag, nicht aus der Env.
    expect('MACVIBES_AGENT_CWD' in env).toBe(false);
  });
});
