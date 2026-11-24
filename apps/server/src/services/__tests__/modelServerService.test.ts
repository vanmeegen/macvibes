import { describe, expect, test } from 'bun:test';
import type { SupervisedProcess } from '../../core/processSupervisor';
import { startModelServer, type ModelServerOptions } from '../modelServerService';

/** Steuerbarer Fake-Prozess (wie im processSupervisor-Test). */
function fakeProcess(): SupervisedProcess & { killed: boolean } {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const box = {
    killed: false,
    exited,
    kill: () => {
      box.killed = true;
      resolveExit(143);
    },
  };
  return box;
}

/** Pflichtangaben, die in diesen Tests keine Rolle spielen. */
const BASIS: Pick<ModelServerOptions, 'label' | 'commandEnvVar' | 'impact' | 'probePath'> = {
  label: 'Lokaler Modell-Server (oMLX)',
  commandEnvVar: 'MACVIBES_LOCAL_ROUTER_CMD',
  impact: 'lokale Modelle sind nicht verfügbar, Claude-Modelle funktionieren normal',
  probePath: '/health',
};

describe('startModelServer — macvibes startet Modell-Server selbst mit', () => {
  test('läuft der Server schon (extern), wird NICHT gespawnt und nicht besessen', async () => {
    let spawned = 0;
    const router = await startModelServer({
      ...BASIS,
      upstreamUrl: 'http://localhost:8787',
      command: 'omlx serve',
      probe: async () => true, // sofort gesund → jemand anderes betreibt ihn
      spawn: () => {
        spawned += 1;
        return fakeProcess();
      },
      readyTimeoutMs: 500,
    });
    expect(router.state).toBe('external');
    expect(spawned).toBe(0);
    await router.stop(); // No-Op — fremder Prozess wird nie angefasst
  });

  test('läuft er nicht, wird gespawnt und auf ready gewartet', async () => {
    let healthy = false;
    let spawned = 0;
    const router = await startModelServer({
      ...BASIS,
      upstreamUrl: 'http://localhost:8787',
      command: 'omlx serve',
      probe: async () => healthy,
      spawn: () => {
        spawned += 1;
        // Server „bootet": nach kurzer Zeit gesund.
        setTimeout(() => {
          healthy = true;
        }, 50);
        return fakeProcess();
      },
      probeIntervalMs: 10,
      readyTimeoutMs: 2_000,
    });
    expect(router.state).toBe('managed');
    expect(spawned).toBe(1);
    await router.stop();
  });

  test('stop() beendet einen selbst gestarteten Server', async () => {
    let healthy = false;
    const procs: ReturnType<typeof fakeProcess>[] = [];
    const router = await startModelServer({
      ...BASIS,
      upstreamUrl: 'http://localhost:8787',
      command: 'omlx serve',
      probe: async () => healthy,
      spawn: () => {
        const p = fakeProcess();
        procs.push(p);
        setTimeout(() => {
          healthy = true;
        }, 20);
        return p;
      },
      probeIntervalMs: 10,
      readyTimeoutMs: 2_000,
    });
    expect(router.state).toBe('managed');
    await router.stop();
    expect(procs[0]?.killed).toBe(true);
  });

  test('ohne Startkommando: klare Meldung, kein Spawn, Status unavailable', async () => {
    const warnings: string[] = [];
    const router = await startModelServer({
      ...BASIS,
      upstreamUrl: 'http://localhost:8787',
      command: null,
      probe: async () => false,
      spawn: () => fakeProcess(),
      readyTimeoutMs: 200,
      log: (msg) => warnings.push(msg),
    });
    expect(router.state).toBe('unavailable');
    expect(warnings.join(' ')).toContain('lokale Modelle');
    await router.stop();
  });

  test('Spawn-Kommando kaputt (Server wird nie gesund) → unavailable statt Hänger', async () => {
    const router = await startModelServer({
      ...BASIS,
      upstreamUrl: 'http://localhost:8787',
      command: './kaputt.sh',
      probe: async () => false, // wird nie gesund
      spawn: () => fakeProcess(),
      probeIntervalMs: 10,
      readyTimeoutMs: 150, // kurze Frist im Test
    });
    expect(router.state).toBe('unavailable');
    await router.stop();
  });

  test('jede Meldung nennt den Server, um den es geht — auch bei der Bridge', async () => {
    // Vorher sprachen ALLE Meldungen vom „lokalen Modell-Router (Qwen)" und von
    // MACVIBES_LOCAL_ROUTER_CMD — auch wenn die LiteLLM-Bridge gemeint war.
    const meldungen: string[] = [];
    await startModelServer({
      label: 'LiteLLM-Bridge',
      commandEnvVar: 'MACVIBES_LITELLM_CMD',
      impact: 'Modelle OpenAI-kompatibler Anbieter sind nicht verfügbar',
      probePath: '/health/liveliness',
      upstreamUrl: 'http://localhost:8787',
      command: null,
      probe: async () => false,
      log: (msg) => meldungen.push(msg),
    });
    const text = meldungen.join(' ');
    expect(text).toContain('LiteLLM-Bridge');
    expect(text).toContain('MACVIBES_LITELLM_CMD');
    expect(text).not.toContain('MACVIBES_LOCAL_ROUTER_CMD');
    expect(text).not.toContain('Qwen');
  });
});
