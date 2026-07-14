import { describe, expect, test } from 'bun:test';
import {
  PreviewSupervisor,
  type PreviewStatus,
  type PreviewSupervisorDeps,
  type SupervisedProcess,
} from '../previewSupervisor';

/** Steuerbarer Fake-Prozess: exited lässt sich von außen auflösen (= Crash). */
function fakeProcess(): SupervisedProcess & { crash: (code?: number) => void; killed: boolean } {
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
    crash: (code = 1) => resolveExit(code),
  };
  return box;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await Bun.sleep(5);
  }
  throw new Error('waitFor: Bedingung nicht erfüllt');
}

interface Harness {
  supervisor: PreviewSupervisor;
  statuses: PreviewStatus[];
  spawnCount: () => number;
  procs: ReturnType<typeof fakeProcess>[];
  setHealthy: (v: boolean) => void;
}

function makeHarness(overrides: Partial<PreviewSupervisorDeps> = {}): Harness {
  const procs: ReturnType<typeof fakeProcess>[] = [];
  const statuses: PreviewStatus[] = [];
  let healthy = false;
  const supervisor = new PreviewSupervisor({
    spawn: () => {
      const p = fakeProcess();
      procs.push(p);
      return p;
    },
    probe: async () => healthy,
    onStatusChange: (s) => statuses.push(s),
    probeIntervalMs: 10,
    startTimeoutMs: 120,
    unhealthyThreshold: 3,
    maxRestarts: 3,
    restartWindowMs: 10_000,
    backoffMs: 10,
    ...overrides,
  });
  return {
    supervisor,
    statuses,
    spawnCount: () => procs.length,
    procs,
    setHealthy: (v) => {
      healthy = v;
    },
  };
}

describe('PreviewSupervisor — Startphase (Dev-Server braucht Zeit)', () => {
  test('bleibt geduldig auf "starting", solange die Startphase läuft — kein Neustart', async () => {
    const h = makeHarness({ startTimeoutMs: 300 });
    h.supervisor.start();

    // 100 ms lang antwortet der Port noch nicht (Server bootet) …
    await Bun.sleep(100);
    expect(h.supervisor.getStatus()).toBe('starting');
    expect(h.spawnCount()).toBe(1); // NICHT neu gestartet
    expect(h.statuses).toEqual(['starting']);

    // … dann wird er erreichbar → ready, immer noch nur ein Spawn.
    h.setHealthy(true);
    await waitFor(() => h.supervisor.getStatus() === 'ready');
    expect(h.spawnCount()).toBe(1);
    expect(h.statuses).toEqual(['starting', 'ready']);

    await h.supervisor.stop();
  });

  test('startet neu, wenn die Startphase ohne "ready" abläuft (Start hängt)', async () => {
    const h = makeHarness({ startTimeoutMs: 60 });
    h.supervisor.start();
    // Port wird nie gesund → nach startTimeout Neustart-Versuch.
    await waitFor(() => h.spawnCount() >= 2, 2000);
    expect(h.statuses).toContain('restarting');
    await h.supervisor.stop();
  });
});

describe('PreviewSupervisor — Laufphase (Crash-Recovery)', () => {
  test('startet den Dev-Server neu, wenn er nach "ready" abstürzt', async () => {
    const h = makeHarness();
    h.setHealthy(true);
    h.supervisor.start();
    await waitFor(() => h.supervisor.getStatus() === 'ready');

    // Dev-Server crasht → Supervisor startet neu und wird wieder ready.
    h.procs[0]?.crash(1);
    await waitFor(() => h.spawnCount() === 2, 2000);
    await waitFor(() => h.supervisor.getStatus() === 'ready');
    expect(h.statuses).toContain('restarting');

    await h.supervisor.stop();
  });

  test('startet neu, wenn der Server hängt (Health-Check fällt dauerhaft aus)', async () => {
    const h = makeHarness({ unhealthyThreshold: 2 });
    h.setHealthy(true);
    h.supervisor.start();
    await waitFor(() => h.supervisor.getStatus() === 'ready');

    h.setHealthy(false); // Server antwortet nicht mehr
    await waitFor(() => h.spawnCount() === 2, 2000);
    await h.supervisor.stop();
  });
});

describe('PreviewSupervisor — Crash-Loop-Schutz & Stop', () => {
  test('gibt nach maxRestarts auf und meldet "failed"', async () => {
    const h = makeHarness({ maxRestarts: 2, startTimeoutMs: 30 });
    // Jeder Start crasht sofort.
    h.supervisor.start();
    await waitFor(() => h.supervisor.getStatus() === 'failed', 3000);
    // Ein Start + maxRestarts Versuche, dann Schluss — nicht endlos.
    expect(h.spawnCount()).toBeLessThanOrEqual(3);
    await h.supervisor.stop();
  });

  test('stop killt den laufenden Prozess und beendet die Überwachung', async () => {
    const h = makeHarness();
    h.setHealthy(true);
    h.supervisor.start();
    await waitFor(() => h.supervisor.getStatus() === 'ready');

    await h.supervisor.stop();
    expect(h.supervisor.getStatus()).toBe('stopped');
    expect(h.procs[0]?.killed).toBe(true);

    // Nach stop keine Neustarts mehr, auch wenn der Prozess „crasht".
    const before = h.spawnCount();
    await Bun.sleep(50);
    expect(h.spawnCount()).toBe(before);
  });
});

describe('Spawn-Fehler dürfen NIE den Server crashen (E2E-Absturz 2026-07-14)', () => {
  // Live-Befund: nach dem Löschen eines Projekts versuchte die Crash-Recovery
  // den Dev-Server im GELÖSCHTEN Workspace neu zu starten — Bun.spawn wirft
  // dann ENOENT, und über das fire-and-forget runCycle() riss die unbehandelte
  // Exception den ganzen macvibes-Server mit (Vite: "http proxy error").
  test('wirft spawn direkt beim Start, wird der Status "failed" — keine Exception', async () => {
    const statuses: PreviewStatus[] = [];
    const supervisor = new PreviewSupervisor({
      spawn: () => {
        throw new Error("ENOENT: no such file or directory, posix_spawn 'sh'");
      },
      probe: async () => false,
      onStatusChange: (s) => statuses.push(s),
      probeIntervalMs: 10,
      startTimeoutMs: 120,
      unhealthyThreshold: 3,
      maxRestarts: 3,
      restartWindowMs: 10_000,
      backoffMs: 10,
    });
    supervisor.start();
    await waitFor(() => supervisor.getStatus() === 'failed');
    await supervisor.stop();
  });

  test('wirft spawn beim NEUSTART (Workspace weg), wird der Status "failed" — keine Exception', async () => {
    let calls = 0;
    const procs: ReturnType<typeof fakeProcess>[] = [];
    const supervisor = new PreviewSupervisor({
      spawn: () => {
        calls += 1;
        if (calls > 1) {
          // Zweiter Start = Crash-Recovery nach Projekt-Löschung → cwd weg.
          throw new Error("ENOENT: no such file or directory, posix_spawn 'sh'");
        }
        const p = fakeProcess();
        procs.push(p);
        return p;
      },
      probe: async () => calls === 1,
      probeIntervalMs: 10,
      startTimeoutMs: 120,
      unhealthyThreshold: 3,
      maxRestarts: 3,
      restartWindowMs: 10_000,
      backoffMs: 10,
    });
    supervisor.start();
    await waitFor(() => supervisor.getStatus() === 'ready');
    procs[0]?.crash(); // Prozess stirbt → Recovery-Neustart läuft in den Spawn-Fehler
    await waitFor(() => supervisor.getStatus() === 'failed');
    await supervisor.stop();
  });
});
