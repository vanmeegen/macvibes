import { query } from '@anthropic-ai/claude-agent-sdk';
import { DaemonSession } from './daemonSession';
import type { QueryHandle } from './daemonSession';
import { parseHostToDaemon } from './protocol';
import type { DaemonToHostMessage } from './protocol';

/**
 * Agent-Daemon: läuft persistent IN der MicroVM (unter dem VM-Supervisor),
 * hält die Claude-Session über das Agent SDK am Leben und spricht mit dem
 * Host über eine ausgehende WebSocket-Verbindung (host.microsandbox.internal,
 * derselbe Weg wie der Credential-Proxy). Ersetzt das fragile
 * claude-CLI-über-`msb exec`-Muster (chatproblems.md).
 *
 * Env:
 * - MACVIBES_AGENT_GATEWAY_URL  ws://host.microsandbox.internal:<port>/agent?sandbox=…&token=…
 * - MACVIBES_AGENT_CWD          Arbeitsverzeichnis (Default: /work)
 */

const gatewayUrl = process.env['MACVIBES_AGENT_GATEWAY_URL'];
if (!gatewayUrl) {
  console.error('MACVIBES_AGENT_GATEWAY_URL fehlt — Daemon kann den Host nicht erreichen.');
  process.exit(1);
}
const cwd = process.env['MACVIBES_AGENT_CWD'] ?? '/work';

let socket: WebSocket | null = null;

const session = new DaemonSession({
  cwd,
  emit: (message: DaemonToHostMessage) => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      // Verbindung gerade weg — der Host bricht den Turn seinerseits ab;
      // die Claude-Session im SDK lebt weiter (nächster Turn resumt nahtlos).
      console.error('Agent-Daemon: Event verworfen (Gateway nicht verbunden):', message.kind);
    }
  },
  createQuery: ({ prompt, cwd: queryCwd, model, resumeSessionId }): QueryHandle =>
    query({
      prompt,
      options: {
        cwd: queryCwd,
        model,
        permissionMode: 'bypassPermissions',
        includePartialMessages: true,
        ...(resumeSessionId !== null ? { resume: resumeSessionId } : {}),
      },
    }),
});

/** Dauerhafte Verbindung zum Host-Gateway mit Backoff-Reconnect. */
function connect(attempt = 0): void {
  const ws = new WebSocket(gatewayUrl as string);
  socket = ws;

  ws.addEventListener('open', () => {
    console.log('Agent-Daemon: mit Host-Gateway verbunden');
    ws.send(JSON.stringify({ kind: 'ready' } satisfies DaemonToHostMessage));
  });

  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    const message = parseHostToDaemon(raw);
    if (message === null) {
      console.error('Agent-Daemon: unverständliche Host-Nachricht verworfen');
      return;
    }
    if (message.kind === 'start-turn') {
      session.startTurn(message);
    } else {
      session.interrupt(message.turnId);
    }
  });

  ws.addEventListener('close', () => {
    if (socket === ws) socket = null;
    const delayMs = Math.min(10_000, 500 * 2 ** Math.min(attempt, 4));
    console.error(`Agent-Daemon: Gateway-Verbindung weg — Reconnect in ${delayMs}ms`);
    setTimeout(() => connect(attempt + 1), delayMs);
  });

  ws.addEventListener('error', (event) => {
    // close folgt ohnehin — hier nur Diagnose.
    console.error('Agent-Daemon: WebSocket-Fehler:', event);
  });

  // Nach erfolgreichem Connect den Backoff zurücksetzen.
  ws.addEventListener('open', () => {
    attempt = 0;
  });
}

connect();
