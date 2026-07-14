import { PreviewSupervisor, type SupervisedProcess } from '../sandbox/previewSupervisor';

/**
 * Lokaler Modell-Router (Anthropic-Shim / LiteLLM) als MITGESTARTETER Prozess:
 * `bun run dev` bringt damit alles hoch, was lokale Modelle brauchen.
 *
 * Verhalten:
 * - Läuft auf der Upstream-URL schon etwas Gesundes → NICHT anfassen
 *   (extern betrieben, z. B. manuell gestartet oder Waise eines Vorlaufs).
 * - Sonst: Startkommando spawnen und via PreviewSupervisor überwachen
 *   (Health-Check, Neustart bei Crash, Crash-Loop-Schutz).
 * - Ohne Startkommando: klare Warnung — Claude-Modelle funktionieren weiter,
 *   nur lokale Modelle nicht.
 */

export type LocalRouterState = 'external' | 'managed' | 'unavailable';

export interface LocalRouterHandle {
  state: LocalRouterState;
  /** Beendet NUR einen selbst gestarteten Shim (extern bleibt unberührt). */
  stop(): Promise<void>;
}

export interface LocalRouterOptions {
  upstreamUrl: string;
  /** Startkommando (sh -c …) oder null = kein Autostart möglich. */
  command: string | null;
  /** Health-Endpunkt relativ zur Upstream-URL (LiteLLM-Default). */
  probePath?: string | undefined;
  /** Log-Datei für stdout/stderr des Shims. */
  logFile?: string | undefined;
  probeIntervalMs?: number | undefined;
  /** Frist je Startversuch, bis der Shim gesund sein muss. */
  readyTimeoutMs?: number | undefined;
  log?: ((message: string) => void) | undefined;
  /** Test-Nähte. */
  probe?: (() => Promise<boolean>) | undefined;
  spawn?: (() => SupervisedProcess) | undefined;
}

export async function startLocalRouter(options: LocalRouterOptions): Promise<LocalRouterHandle> {
  const log = options.log ?? ((message: string) => console.log(message));
  const probePath = options.probePath ?? '/health/liveliness';
  const probe =
    options.probe ??
    (async (): Promise<boolean> => {
      try {
        const response = await fetch(`${options.upstreamUrl}${probePath}`, {
          signal: AbortSignal.timeout(1_500),
        });
        return response.ok;
      } catch {
        return false;
      }
    });

  // Schon jemand da? Dann gehört der Prozess nicht uns — Finger weg.
  if (await probe()) {
    log(`Lokaler Modell-Router läuft bereits (extern) auf ${options.upstreamUrl}`);
    return { state: 'external', stop: async () => {} };
  }

  if (options.command === null) {
    log(
      'Kein lokaler Modell-Router erreichbar und kein Startkommando konfiguriert ' +
        '(MACVIBES_LOCAL_ROUTER_CMD) — lokale Modelle (Qwen) sind nicht verfügbar, ' +
        'Claude-Modelle funktionieren normal.',
    );
    return { state: 'unavailable', stop: async () => {} };
  }

  const command = options.command;
  const spawn =
    options.spawn ??
    ((): SupervisedProcess => {
      // Output in eine Log-Datei, nicht ins Server-Log (LiteLLM ist gesprächig).
      const redirect = options.logFile ? ` >> ${JSON.stringify(options.logFile)} 2>&1` : '';
      const proc = Bun.spawn(['sh', '-c', `exec ${command}${redirect}`], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      return { exited: proc.exited, kill: () => proc.kill() };
    });

  const supervisor = new PreviewSupervisor({
    spawn,
    probe,
    probeIntervalMs: options.probeIntervalMs ?? 500,
    startTimeoutMs: options.readyTimeoutMs ?? 30_000,
    unhealthyThreshold: 6,
    maxRestarts: 3,
    restartWindowMs: 5 * 60_000,
    backoffMs: 1_000,
  });
  supervisor.start();

  // Auf ein terminales Ergebnis des ersten Hochfahrens warten: ready → managed,
  // failed (Crash-Loop-Schutz) → unavailable. Der Supervisor garantiert eines
  // von beiden, weil ein nie gesunder Start nach maxRestarts als failed endet.
  const state = await new Promise<LocalRouterState>((resolve) => {
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
    log(`Lokaler Modell-Router gestartet und gesund auf ${options.upstreamUrl} (verwaltet)`);
  } else {
    log(
      `Lokaler Modell-Router konnte nicht gestartet werden (Kommando: ${command}) — ` +
        `Details ggf. in ${options.logFile ?? 'der Shim-Log-Datei'}. ` +
        'Lokale Modelle sind nicht verfügbar, Claude-Modelle funktionieren normal.',
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
