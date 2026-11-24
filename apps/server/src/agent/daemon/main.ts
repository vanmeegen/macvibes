import { query } from '@anthropic-ai/claude-agent-sdk';
import { GUEST_WORKDIR, MONIT_HTTPD_PORT } from '../../core/vmContract';
import { httpProbe } from '../../preview/httpProbe';
import { defaultAppendSystemPrompt } from '../appendPrompt';
import { DaemonSession } from './daemonSession';
import { GatewayConnection } from './gatewayConnection';
import type { QueryHandle } from './daemonSession';
import { PreviewStatusReporter } from './previewStatusReporter';
import type { DaemonToHostMessage } from './protocol';

/**
 * Agent-Daemon: läuft persistent IN der MicroVM (unter dem VM-Supervisor),
 * hält die Claude-Session über das Agent SDK am Leben und spricht mit dem
 * Host über eine ausgehende WebSocket-Verbindung (host.microsandbox.internal,
 * derselbe Weg wie der Credential-Proxy). Ersetzt das fragile
 * claude-CLI-über-`msb exec`-Muster (docs/archiv/chatproblems.md).
 *
 * Env:
 * - MACVIBES_AGENT_GATEWAY_URL  ws://host.microsandbox.internal:<port>/agent?sandbox=…&token=…
 * - MACVIBES_AGENT_CWD          Arbeitsverzeichnis (Default: GUEST_WORKDIR)
 * - MACVIBES_AGENT_APPEND_PROMPT  optionale Zusatz-System-Anweisung (Default: agent/appendPrompt)
 */

const gatewayUrl = process.env['MACVIBES_AGENT_GATEWAY_URL'];
if (!gatewayUrl) {
  console.error('MACVIBES_AGENT_GATEWAY_URL fehlt — Daemon kann den Host nicht erreichen.');
  process.exit(1);
}
// Fallback aus dem Host↔VM-Vertrag: derselbe Wert, den der Provider als
// Workspace-Mountpunkt nutzt — eine eigene Kopie hier driftete sonst still.
const cwd = process.env['MACVIBES_AGENT_CWD'] ?? GUEST_WORKDIR;

// Zusatz-System-Anweisung: Übersteuerung aus der VM-Env (der Host reicht
// config.agent.appendSystemPrompt über buildVmAgentEnv herein), sonst der
// eingebaute Default — derselbe wie im Host-Runner.
const appendSystemPrompt =
  process.env['MACVIBES_AGENT_APPEND_PROMPT'] ?? defaultAppendSystemPrompt(cwd);

// Die Session entsteht vor der Verbindung (ihre Events brauchen `send`), die
// Verbindung vor dem ersten Kommando — deshalb die späte Referenz.
let connection: GatewayConnection | null = null;
const send = (message: DaemonToHostMessage): boolean => connection?.send(message) ?? false;

const session = new DaemonSession({
  cwd,
  emit: (message: DaemonToHostMessage) => {
    if (message.kind === 'event') {
      console.log(`Agent-Daemon: Event ${message.event.type} (Turn ${message.turnId})`);
    }
    if (!send(message)) {
      // Verbindung gerade weg — der Host bricht den Turn seinerseits ab;
      // die Claude-Session im SDK lebt weiter (nächster Turn resumt nahtlos).
      console.error('Agent-Daemon: Event verworfen (Gateway nicht verbunden):', message.kind);
    }
  },
  createQuery: ({ prompt, cwd: queryCwd, model, resumeSessionId }): QueryHandle => {
    console.log(
      `Agent-Daemon: erzeuge SDK-Query (model=${model}, resume=${resumeSessionId ?? 'nein'})`,
    );
    return query({
      prompt,
      options: {
        cwd: queryCwd,
        model,
        // Claude-Code-Preset behalten (Tools/Verhalten) + macvibes-Anweisung anhängen.
        systemPrompt: { type: 'preset', preset: 'claude_code', append: appendSystemPrompt },
        // Projekt-Memory laden (AGENTS.md/CLAUDE.md aus dem Workspace) — ohne dies
        // ignoriert das SDK die Dateien. Gibt schwachen Modellen den Projektkontext,
        // den Claude sich sonst selbst erschließt.
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        ...(resumeSessionId !== null ? { resume: resumeSessionId } : {}),
      },
    });
  },
});

/**
 * Preview-Status-Push (ADR 0001): monit lokal lesen, Status über die stehende
 * Daemon-Verbindung melden — kein fragiles monit-Port-Mapping auf dem Host.
 * Ohne MACVIBES_PREVIEW_PORT läuft der Daemon
 * ohne Reporter weiter; der Host fällt dann auf seine HTTP-Probe zurück.
 */
const previewPort = Number(process.env['MACVIBES_PREVIEW_PORT'] ?? '');
// Default aus dem Host↔VM-Vertrag: exakt der Port, den vmServices in die
// monitrc schreibt — ein zweiter hartkodierter Wert liefe still auseinander.
const monitPort = Number(process.env['MACVIBES_MONIT_PORT'] ?? MONIT_HTTPD_PORT);
if (Number.isFinite(previewPort) && previewPort > 0) {
  const reporter = new PreviewStatusReporter({
    fetchMonitText: async () => {
      const response = await fetch(`http://127.0.0.1:${monitPort}/_status?format=text`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) throw new Error(`monit-Status ${response.status}`);
      return response.text();
    },
    probe: () => httpProbe(`http://127.0.0.1:${previewPort}/`),
    // Ohne Verbindung verworfen: der nächste Takt meldet den dann aktuellen Status.
    send: (status) => void send({ kind: 'preview-status', status }),
  });
  reporter.start();
} else {
  console.error('Agent-Daemon: MACVIBES_PREVIEW_PORT fehlt — kein Preview-Status-Push.');
}

// Dauerhafte Verbindung zum Host-Gateway (Anmeldung, Heartbeat, Kommandos,
// Backoff-Reconnect): gatewayConnection.ts.
connection = new GatewayConnection({
  url: gatewayUrl,
  session: {
    startTurn: (message) => session.startTurn(message),
    interrupt: (turnId) => session.interrupt(turnId),
    abandonTurn: () => session.abandonTurn(),
  },
  // Sauber beenden — der In-VM-Supervisor (monit) startet den Daemon frisch.
  onShutdown: () => process.exit(0),
});
connection.start();
