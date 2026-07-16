import { describe, expect, test } from 'bun:test';
import type { SandboxContext, SandboxHandle, SandboxProvider } from '../provider';
import { SandboxManager } from '../sandboxManager';

function ctx(projectId: string): SandboxContext {
  return {
    projectId,
    branchName: `marco/${projectId}`,
    workspaceDir: `/tmp/fake/${projectId}`,
    templateDir: 'pwa',
    devCommand: 'bun run dev',
    previewPort: 5173,
  };
}

class FakeProvider implements SandboxProvider {
  startCalls: string[] = [];
  stopCalls: string[] = [];

  async start(context: SandboxContext): Promise<SandboxHandle> {
    this.startCalls.push(context.projectId);
    return {
      previewHostPort: 9999,
      previewStatus: () => 'ready' as const,
      stop: async () => {
        this.stopCalls.push(context.projectId);
      },
    };
  }
}

interface Setup {
  provider: FakeProvider;
  manager: SandboxManager;
  statusLog: string[];
  beforeStopLog: string[];
}

function setup(
  overrides: {
    graceMs?: number;
    idleMs?: number;
    maxSandboxes?: number;
    isBusy?: (projectId: string) => boolean;
  } = {},
): Setup {
  const provider = new FakeProvider();
  const statusLog: string[] = [];
  const beforeStopLog: string[] = [];
  const manager = new SandboxManager({
    provider,
    graceMs: overrides.graceMs ?? 40,
    idleMs: overrides.idleMs ?? 10_000,
    maxSandboxes: overrides.maxSandboxes ?? 8,
    ...(overrides.isBusy !== undefined ? { isBusy: overrides.isBusy } : {}),
    onBeforeStop: async (projectId) => {
      beforeStopLog.push(projectId);
    },
    onStatusChange: (projectId, status) => {
      statusLog.push(`${projectId}:${status}`);
    },
  });
  return { provider, manager, statusLog, beforeStopLog };
}

describe('enter', () => {
  test('startet die Sandbox und meldet Statusübergänge', async () => {
    const { provider, manager, statusLog } = setup();
    await manager.enter(ctx('p1'));
    expect(manager.status('p1')).toBe('running');
    expect(provider.startCalls).toEqual(['p1']);
    expect(statusLog).toEqual(['p1:starting', 'p1:running']);
  });

  test('startet eine laufende Sandbox nicht doppelt', async () => {
    const { provider, manager } = setup();
    await manager.enter(ctx('p1'));
    await manager.enter(ctx('p1'));
    expect(provider.startCalls).toEqual(['p1']);
  });

  test('ein zweiter enter() während des Starts wartet auf den laufenden Start (Race-Fix)', async () => {
    // Provider mit verzögertem Start — simuliert die VM, die erst exec-bereit wird.
    let started = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const provider: SandboxProvider = {
      async start(_context) {
        await gate;
        started = true;
        return { previewHostPort: 1, previewStatus: () => 'ready' as const, stop: async () => {} };
      },
    };
    const manager = new SandboxManager({
      provider,
      graceMs: 1000,
      idleMs: 10_000,
      maxSandboxes: 8,
    });

    const first = manager.enter(ctx('p1'));
    // Warten bis der Status wirklich 'starting' ist (Start läuft, hängt am Gate).
    await Bun.sleep(10);
    expect(manager.status('p1')).toBe('starting');

    // Zweiter enter, während der erste noch im Start hängt:
    let secondResolved = false;
    const second = manager.enter(ctx('p1')).then(() => {
      secondResolved = true;
    });
    await Bun.sleep(20);
    // Der zweite enter darf NICHT zurückkehren, solange der Start nicht fertig ist.
    expect(secondResolved).toBe(false);
    expect(started).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(secondResolved).toBe(true);
    expect(manager.status('p1')).toBe('running');
    // Nur EIN echter Start (kein Doppelstart durch den zweiten enter).
    expect(manager.status('p1')).toBe('running');
  });

  test('unbekannte Projekte sind stopped', () => {
    const { manager } = setup();
    expect(manager.status('unbekannt')).toBe('stopped');
  });

  test('liefert den Preview-Host-Port der laufenden Sandbox', async () => {
    const { manager } = setup();
    await manager.enter(ctx('p1'));
    expect(manager.previewHostPort('p1')).toBe(9999);
    expect(manager.previewHostPort('anderes')).toBeNull();
  });
});

describe('leave / Grace-Period (R9)', () => {
  test('stoppt nach Ablauf der Grace-Period, Auto-Commit-Hook vor dem Stopp', async () => {
    const { provider, manager, beforeStopLog } = setup({ graceMs: 30 });
    await manager.enter(ctx('p1'));
    manager.leave('p1');
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
    expect(provider.stopCalls).toEqual(['p1']);
    expect(beforeStopLog).toEqual(['p1']);
  });

  test('erneutes Betreten innerhalb der Grace-Period verhindert den Stopp', async () => {
    const { provider, manager } = setup({ graceMs: 60 });
    await manager.enter(ctx('p1'));
    manager.leave('p1');
    await Bun.sleep(20);
    await manager.enter(ctx('p1'));
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
    expect(provider.startCalls).toEqual(['p1']);
  });

  test('Grace-Stopp wird aufgeschoben, solange ein Turn läuft', async () => {
    let busy = true;
    const { provider, manager } = setup({ graceMs: 20, isBusy: () => busy });
    await manager.enter(ctx('p1'));
    manager.leave('p1');

    // Mehrere Grace-Zyklen lang beschäftigt — kein Stopp trotz Ablauf.
    await Bun.sleep(90);
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);

    // Turn endet → der nächste Grace-Zyklus stoppt die Sandbox.
    busy = false;
    await Bun.sleep(90);
    expect(manager.status('p1')).toBe('stopped');
    expect(provider.stopCalls).toEqual(['p1']);
  });

  test('erneutes Betreten während des aufgeschobenen Grace-Stopps hält die Sandbox am Leben', async () => {
    const busy = true;
    const { provider, manager } = setup({ graceMs: 20, isBusy: () => busy });
    await manager.enter(ctx('p1'));
    manager.leave('p1');
    await Bun.sleep(50);
    await manager.enter(ctx('p1'));
    await Bun.sleep(90);
    // Wieder betreten: Grace ist abgeräumt, busy spielt keine Rolle mehr.
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
  });
});

describe('Agent-Idle (R9, 30-min-Regel)', () => {
  test('stoppt bei Agent-Inaktivität auch ohne leave', async () => {
    const { manager } = setup({ idleMs: 40 });
    await manager.enter(ctx('p1'));
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
  });

  test('Agent-Aktivität verschiebt den Idle-Stopp', async () => {
    const { manager } = setup({ idleMs: 60 });
    await manager.enter(ctx('p1'));
    await Bun.sleep(30);
    manager.noteAgentActivity('p1');
    await Bun.sleep(40);
    expect(manager.status('p1')).toBe('running');
    await Bun.sleep(60);
    expect(manager.status('p1')).toBe('stopped');
  });
});

describe('LRU-Limit (R9, max Sandboxes)', () => {
  test('stoppt die am längsten inaktive Sandbox beim Überschreiten', async () => {
    const { provider, manager } = setup({ maxSandboxes: 2, graceMs: 10_000 });
    await manager.enter(ctx('p1'));
    await Bun.sleep(5);
    await manager.enter(ctx('p2'));
    await Bun.sleep(5);
    manager.noteAgentActivity('p1');
    await manager.enter(ctx('p3'));

    // p2 ist am längsten inaktiv → wird verdrängt; p1 und p3 laufen.
    expect(manager.status('p2')).toBe('stopped');
    expect(manager.status('p1')).toBe('running');
    expect(manager.status('p3')).toBe('running');
    expect(provider.stopCalls).toEqual(['p2']);
  });
});

describe('stopAll', () => {
  test('stoppt alle laufenden Sandboxes', async () => {
    const { provider, manager } = setup();
    await manager.enter(ctx('p1'));
    await manager.enter(ctx('p2'));
    await manager.stopAll();
    expect(manager.status('p1')).toBe('stopped');
    expect(manager.status('p2')).toBe('stopped');
    expect(provider.stopCalls.sort()).toEqual(['p1', 'p2']);
  });
});
