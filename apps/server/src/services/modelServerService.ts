import { spawnShellCommand } from '../core/exec';
import { ProcessSupervisor, type SupervisedProcess } from '../core/processSupervisor';

/**
 * Ein Modell-Server als MITGESTARTETER Prozess: `bun run dev` bringt damit
 * alles hoch, was Nicht-Claude-Modelle brauchen. Wird zweimal benutzt — für
 * den lokalen Modell-Server (oMLX) und für die optionale LiteLLM-Bridge; die
 * Funktion kennt keinen von beiden (alles Spezifische kommt als Option).
 *
 * Verhalten:
 * - Läuft auf der Upstream-URL schon etwas Gesundes → NICHT anfassen
 *   (extern betrieben, z. B. manuell gestartet oder Waise eines Vorlaufs).
 * - Sonst: Startkommando spawnen und via ProcessSupervisor überwachen
 *   (Health-Check, Neustart bei Crash, Crash-Loop-Schutz).
 * - Ohne Startkommando: klare Warnung — Claude-Modelle funktionieren weiter,
 *   nur die Modelle hinter diesem Server nicht.
 */

export type ModelServerState = 'external' | 'managed' | 'unavailable';

export interface ModelServerHandle {
  state: ModelServerState;
  /** Beendet NUR einen selbst gestarteten Server (extern bleibt unberührt). */
  stop(): Promise<void>;
}

/** Platzhalter, wenn gar kein Server gestartet werden soll (Fake-Agent, Bridge aus). */
export const MODEL_SERVER_UNAVAILABLE: ModelServerHandle = {
  state: 'unavailable',
  stop: async () => {},
};

export interface ModelServerOptions {
  /** Name in allen Log-Zeilen, z. B. „Lokaler Modell-Server (oMLX)". */
  label: string;
  upstreamUrl: string;
  /** Startkommando (Bun-Shell) oder null = kein Autostart möglich. */
  command: string | null;
  /** Env-Variable, die das Startkommando setzt — steht im Hinweis ohne Kommando. */
  commandEnvVar: string;
  /** Was ohne diesen Server fehlt, als ganzer Satzteil für die Warnungen. */
  impact: string;
  /** Health-Endpunkt relativ zur Upstream-URL (oMLX `/health`, LiteLLM `/health/liveliness`). */
  probePath: string;
  /** Log-Datei für stdout/stderr des Servers. */
  logFile?: string | undefined;
  probeIntervalMs?: number | undefined;
  /** Frist je Startversuch, bis der Server gesund sein muss. */
  readyTimeoutMs?: number | undefined;
  log?: ((message: string) => void) | undefined;
  /** Test-Nähte. */
  probe?: (() => Promise<boolean>) | undefined;
  spawn?: (() => SupervisedProcess) | undefined;
}

export async function startModelServer(options: ModelServerOptions): Promise<ModelServerHandle> {
  const log = options.log ?? ((message: string) => console.log(message));
  const probe =
    options.probe ??
    (async (): Promise<boolean> => {
      try {
        const response = await fetch(`${options.upstreamUrl}${options.probePath}`, {
          signal: AbortSignal.timeout(1_500),
        });
        return response.ok;
      } catch {
        return false;
      }
    });

  // Schon jemand da? Dann gehört der Prozess nicht uns — Finger weg.
  if (await probe()) {
    log(`${options.label} läuft bereits (extern) auf ${options.upstreamUrl}`);
    return { state: 'external', stop: async () => {} };
  }

  if (options.command === null) {
    log(
      `${options.label} ist nicht erreichbar und es ist kein Startkommando konfiguriert ` +
        `(${options.commandEnvVar}) — ${options.impact}.`,
    );
    return { state: 'unavailable', stop: async () => {} };
  }

  const command = options.command;
  const spawn =
    options.spawn ??
    ((): SupervisedProcess =>
      // Output in eine Log-Datei, nicht ins Server-Log (Modell-Server sind gesprächig).
      // Plattformneutral (bun exec + tree-kill statt sh -c + Shell-Redirect).
      spawnShellCommand(command, { logFile: options.logFile }));

  const supervisor = new ProcessSupervisor({
    spawn,
    probe,
    probeIntervalMs: options.probeIntervalMs ?? 500,
    // Großzügig: der allererste Start der LiteLLM-Bridge legt die venv an und
    // installiert LiteLLM (~1–2 min), ein Modell-Server lädt erst Gewichte. Ein kaputtes Kommando scheitert trotzdem schnell (Prozess-Exit
    // → Crash-Loop-Schutz), die Frist greift nur bei ehrlich langsamem Boot.
    startTimeoutMs: options.readyTimeoutMs ?? 300_000,
    unhealthyThreshold: 6,
    maxRestarts: 3,
    restartWindowMs: 5 * 60_000,
    backoffMs: 1_000,
  });
  supervisor.start();

  // Auf ein terminales Ergebnis des ersten Hochfahrens warten: ready → managed,
  // failed (Crash-Loop-Schutz) → unavailable. Der Supervisor garantiert eines
  // von beiden, weil ein nie gesunder Start nach maxRestarts als failed endet.
  const state = await new Promise<ModelServerState>((resolve) => {
    const timer = setInterval(() => {
      const status = supervisor.getStatus();
      if (status === 'ready') {
        clearInterval(timer);
        resolve('managed');
      } else if (status === 'failed') {
        clearInterval(timer);
        resolve('unavailable');
      }
    }, options.probeIntervalMs ?? 500);
  });

  if (state === 'managed') {
    log(`${options.label} gestartet und gesund auf ${options.upstreamUrl} (verwaltet)`);
  } else {
    log(
      `${options.label} konnte nicht gestartet werden (Kommando: ${command}) — ` +
        `Details ggf. in ${options.logFile ?? 'der Log-Datei des Servers'}. ${options.impact}.`,
    );
    await supervisor.stop();
  }

  return {
    state,
    stop: async () => {
      await supervisor.stop();
    },
  };
}
