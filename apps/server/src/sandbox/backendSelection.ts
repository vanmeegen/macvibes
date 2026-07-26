/**
 * Auflösung der Backend-Kombination (Sandbox-Provider + Agent-Transport).
 *
 * Eigene, reine Funktion, weil `index.ts` wegen seiner Top-Level-Effekte nicht
 * testbar ist — und weil hier eine Sicherheitsentscheidung fällt (F9).
 */

export type SandboxBackend = 'process' | 'microsandbox';
export type AgentBackend = 'fake' | 'daemon' | 'host';

export interface BackendSelectionInput {
  /** `MACVIBES_SANDBOX` bzw. config.sandbox.backend. */
  configured: 'auto' | 'process' | 'microsandbox';
  /** `MACVIBES_AGENT` bzw. config.agent.backend. */
  agent: 'claude' | 'fake';
  /** Ist die msb-CLI auf dem Host vorhanden? */
  msbAvailable: boolean;
  /** `MACVIBES_ALLOW_HOST_AGENT=1` — ausdrücklicher Verzicht auf das Isolat. */
  allowHostAgent: boolean;
}

export interface BackendSelection {
  sandbox: SandboxBackend;
  agent: AgentBackend;
}

/** Der Server darf so nicht starten — Agentencode liefe ohne Isolation. */
export class UnsafeBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeBackendError';
  }
}

/**
 * Wählt die Backends und verweigert die unsichere Kombination.
 *
 * Der echte Agent (Claude Code, `permissionMode: 'bypassPermissions'`) darf nur
 * in einer MicroVM laufen. Ohne microsandbox liefe er als Host-Prozess mit den
 * Rechten des angemeldeten Nutzers — bisher geschah das still, jetzt bricht der
 * Start ab. Der Fake-Agent führt keinen fremden Code aus und bleibt überall
 * erlaubt (Tests und Playwright-E2E).
 */
export function selectBackends(input: BackendSelectionInput): BackendSelection {
  const wantsVm = input.configured === 'microsandbox' || input.configured === 'auto';
  const sandbox: SandboxBackend = wantsVm && input.msbAvailable ? 'microsandbox' : 'process';

  if (input.agent === 'fake') {
    return { sandbox, agent: 'fake' };
  }

  if (sandbox === 'microsandbox') {
    return { sandbox, agent: 'daemon' };
  }

  if (input.allowHostAgent) {
    return { sandbox: 'process', agent: 'host' };
  }

  throw new UnsafeBackendError(
    `${reasonFor(input)} Der Agent liefe damit ohne VM-Isolat als Host-Prozess ` +
      `(bypassPermissions) — der Start wird verweigert. Entweder microsandbox ` +
      `installieren (brew install superradcompany/tap/microsandbox) oder den ` +
      `Verzicht ausdrücklich erklären: MACVIBES_ALLOW_HOST_AGENT=1.`,
  );
}

function reasonFor(input: BackendSelectionInput): string {
  if (input.configured === 'process') {
    return 'MACVIBES_SANDBOX=process ist gesetzt, aber MACVIBES_AGENT ist nicht "fake".';
  }
  if (input.configured === 'microsandbox') {
    return 'MACVIBES_SANDBOX=microsandbox ist gesetzt, aber die msb-CLI fehlt.';
  }
  return 'Die msb-CLI wurde nicht gefunden.';
}
