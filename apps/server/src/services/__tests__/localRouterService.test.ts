import { describe, expect, test } from 'bun:test';
import type { SupervisedProcess } from '../../sandbox/previewSupervisor';
import { startLocalRouter } from '../localRouterService';

/** Steuerbarer Fake-Prozess (wie im previewSupervisor-Test). */
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

describe('startLocalRouter — macvibes startet den Anthropic-Shim selbst mit', () => {
  test('läuft der Shim schon (extern), wird NICHT gespawnt und nicht besessen', async () => {
    let spawned = 0;
    const router = await startLocalRouter({
      upstreamUrl: 'http://localhost:8787',
      command: './run-anthropic-shim.sh',
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
    const router = await startLocalRouter({
      upstreamUrl: 'http://localhost:8787',
      command: './run-anthropic-shim.sh',
      probe: async () => healthy,
      spawn: () => {
        spawned += 1;
        // Shim „bootet": nach kurzer Zeit gesund.
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

  test('stop() beendet einen selbst gestarteten Shim', async () => {
    let healthy = false;
    const procs: ReturnType<typeof fakeProcess>[] = [];
    const router = await startLocalRouter({
      upstreamUrl: 'http://localhost:8787',
      command: './run-anthropic-shim.sh',
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
    const router = await startLocalRouter({
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

  test('Spawn-Kommando kaputt (Shim wird nie gesund) → unavailable statt Hänger', async () => {
    const router = await startLocalRouter({
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
});
