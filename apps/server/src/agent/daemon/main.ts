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

/**
 * Zusätzliche System-Anweisung an das Modell. Nötig für schwächere lokale
 * Modelle (z. B. qwen3.6-coder), die sonst (a) Arbeit nur ankündigen statt Tools
 * aufzurufen und (b) Dateien nach /home/user statt ins Projekt (cwd) schreiben —
 * beides macht die Live-Preview „tot". Für die Claude-API ist die Anweisung ein
 * harmloses No-Op (macht es ohnehin richtig). Über Env überschreibbar.
 */
const appendSystemPrompt =
  process.env['MACVIBES_AGENT_APPEND_PROMPT'] ??
  `WICHTIG (macvibes-Laufzeitumgebung): Das Projekt liegt im aktuellen ` +
    `Arbeitsverzeichnis ${cwd}. Erstelle und bearbeite ALLE Dateien ausschließlich ` +
    `dort mit RELATIVEN Pfaden. Verwende NIEMALS absolute Pfade wie /home/user/... ` +
    `oder /root/... — Dateien außerhalb von ${cwd} sind für die Live-Preview unsichtbar. ` +
    `Lies zuerst AGENTS.md im Projekt und HALTE DICH DARAN (welche Datei die App-Wurzel ` +
    `ist, was ausgeliefert wird). Beende deinen Turn NIEMALS mit einer Ankündigung wie ` +
    `"Jetzt mache ich X" oder "Als Nächstes …" — führe angekündigte Schritte SOFORT im ` +
    `selben Turn aus und arbeite die Aufgabe vollständig ab, bevor du zusammenfasst.`;

let socket: WebSocket | null = null;

const session = new DaemonSession({
  cwd,
  emit: (message: DaemonToHostMessage) => {
    if (message.kind === 'event') {
      console.log(`Agent-Daemon: Event ${message.event.type} (Turn ${message.turnId})`);
    }
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
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
 * Heartbeat-Intervall: hält den NAT-Flow VM→Host warm. microsandbox lässt
 * idle TCP-Flows nach kurzer Zeit still sterben — ohne Ping verschwinden
 * Host-Kommandos nach ruhigen Phasen spurlos (Live-Befund 2026-07-06).
 */
const PING_INTERVAL_MS = 15_000;

/** Dauerhafte Verbindung zum Host-Gateway mit Backoff-Reconnect. */
function connect(attempt = 0): void {
  const ws = new WebSocket(gatewayUrl as string);
  socket = ws;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  ws.addEventListener('open', () => {
    console.log('Agent-Daemon: mit Host-Gateway verbunden');
    ws.send(JSON.stringify({ kind: 'ready' } satisfies DaemonToHostMessage));
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ kind: 'ping' } satisfies DaemonToHostMessage));
      }
    }, PING_INTERVAL_MS);
  });

  ws.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : '';
    const message = parseHostToDaemon(raw);
    if (message === null) {
      console.error('Agent-Daemon: unverständliche Host-Nachricht verworfen:', raw.slice(0, 200));
      return;
    }
    if (message.kind === 'pong') {
      // Heartbeat-Antwort — hält den NAT-Flow in beide Richtungen aktiv.
      return;
    }
    console.log(
      `Agent-Daemon: Kommando ${message.kind}` +
        ('turnId' in message ? ` (Turn ${message.turnId})` : ''),
    );
    try {
      if (message.kind === 'start-turn') {
        // Sofortige Quittung: beweist dem Host, dass das Kommando ankam
        // (Schutz gegen halbtote Verbindungen nach Daemon-Neustart).
        ws.send(
          JSON.stringify({
            kind: 'turn-started',
            turnId: message.turnId,
          } satisfies DaemonToHostMessage),
        );
        session.startTurn(message);
      } else if (message.kind === 'interrupt') {
        session.interrupt(message.turnId);
      } else {
        // shutdown: sauber beenden — der In-VM-Supervisor startet uns frisch.
        console.error('Agent-Daemon: Shutdown angefordert — Supervisor übernimmt den Neustart.');
        process.exit(0);
      }
    } catch (error) {
      // Nie still scheitern — der Host würde sonst ewig warten.
      console.error('Agent-Daemon: Kommando fehlgeschlagen:', error);
      if (message.kind === 'start-turn') {
        const failure: DaemonToHostMessage = {
          kind: 'event',
          turnId: message.turnId,
          event: { type: 'error', message: `Daemon-Kommando fehlgeschlagen: ${String(error)}` },
        };
        const abort: DaemonToHostMessage = {
          kind: 'event',
          turnId: message.turnId,
          event: { type: 'turn-aborted' },
        };
        ws.send(JSON.stringify(failure));
        ws.send(JSON.stringify(abort));
      }
    }
  });

  ws.addEventListener('close', () => {
    if (pingTimer !== null) clearInterval(pingTimer);
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
