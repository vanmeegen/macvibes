import { describe, expect, test } from 'bun:test';
import type { SandboxContext, SandboxHandle, SandboxProvider } from '../provider';
import { SandboxManager } from '../sandboxManager';
import { ctx, setup, torProvider } from './sandboxManagerFixtures';

describe('enter', () => {
  test('startet die Sandbox und meldet Statusübergänge', async () => {
    const { provider, manager, statusLog } = setup();
    await manager.enter(ctx('p1'), 'u1');
    expect(manager.status('p1')).toBe('running');
    expect(provider.startCalls).toEqual(['p1']);
    expect(statusLog).toEqual(['p1:starting', 'p1:running']);
  });

  test('startet eine laufende Sandbox nicht doppelt', async () => {
    const { provider, manager } = setup();
    await manager.enter(ctx('p1'), 'u1');
    await manager.enter(ctx('p1'), 'u1');
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

    const first = manager.enter(ctx('p1'), 'u1');
    // Warten bis der Status wirklich 'starting' ist (Start läuft, hängt am Gate).
    await Bun.sleep(10);
    expect(manager.status('p1')).toBe('starting');

    // Zweiter enter, während der erste noch im Start hängt:
    let secondResolved = false;
    const second = manager.enter(ctx('p1'), 'u1').then(() => {
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
    await manager.enter(ctx('p1'), 'u1');
    expect(manager.previewHostPort('p1')).toBe(9999);
    expect(manager.previewHostPort('anderes')).toBeNull();
  });
});

/**
 * stop() akzeptierte einen Eintrag im Status `starting`, wartete den laufenden
 * Start (`startPromise`) aber nie ab: `entry.handle` ist waehrend des Starts
 * noch null, also stoppte stop() nichts, meldete Erfolg — und der Start setzte
 * danach das Handle und schaltete den Eintrag zurueck auf `running`.
 *
 * Jeder Aufrufer, der einem aufgeloesten stop() glaubt, lag damit falsch:
 * stopAll() liess beim Herunterfahren eine MicroVM zurueck, die LRU-Eviction
 * gab einen Platz frei, der sofort wieder belegt war — und der
 * deleteProject-Resolver loeschte direkt nach stop() das Projektvolume, also
 * Workspace, Git und Agent-Config unter einer VM weg, die gerade hochkam und
 * mit gueltigem Gateway-Token weiterlief.
 */
describe('stop() waehrend eines laufenden Starts', () => {
  test('wartet den Start ab und stoppt die VM wirklich', async () => {
    let startFreigeben: () => void = () => {};
    const startLaeuft = new Promise<void>((resolve) => {
      startFreigeben = resolve;
    });
    const gestoppt: string[] = [];
    const provider: SandboxProvider = {
      async start(context: SandboxContext): Promise<SandboxHandle> {
        await startLaeuft;
        return {
          previewHostPort: 9999,
          previewStatus: () => 'ready' as const,
          stop: async () => {
            gestoppt.push(context.projectId);
          },
        };
      },
    };
    const manager = new SandboxManager({
      provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
    });

    // Start anstossen, aber nicht abwarten — er haengt im Provider fest.
    const eintritt = manager.enter(ctx('p1'), 'marco');
    await Bun.sleep(10);
    expect(manager.status('p1')).toBe('starting');

    // Stoppen, waehrend der Start noch laeuft, und den Start dann freigeben.
    const stopp = manager.stop('p1');
    await Bun.sleep(10);
    startFreigeben();
    await stopp;
    await eintritt;

    // Ohne Fix stuende hier 'running' und `gestoppt` waere leer: die VM liefe
    // weiter, obwohl stop() Erfolg gemeldet hat.
    expect(manager.status('p1')).toBe('stopped');
    expect(gestoppt).toEqual(['p1']);
  });

  test('ein gescheiterter Start hinterlaesst nichts zu stoppen', async () => {
    let startFreigeben: () => void = () => {};
    const startLaeuft = new Promise<void>((resolve) => {
      startFreigeben = resolve;
    });
    const provider: SandboxProvider = {
      async start(): Promise<SandboxHandle> {
        await startLaeuft;
        throw new Error('msb antwortet nicht');
      },
    };
    const manager = new SandboxManager({
      provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
    });

    const eintritt = manager.enter(ctx('p1'), 'marco');
    await Bun.sleep(10);
    const stopp = manager.stop('p1');
    startFreigeben();

    // Der Startfehler gehoert dem enter()-Aufrufer, nicht dem Stopper.
    await expect(eintritt).rejects.toThrow('msb antwortet nicht');
    await expect(stopp).resolves.toBeUndefined();
    expect(manager.status('p1')).toBe('stopped');
  });
});

describe('leave / Grace-Period (R9)', () => {
  test('stoppt nach Ablauf der Grace-Period, Auto-Commit-Hook vor dem Stopp', async () => {
    const { provider, manager, beforeStopLog } = setup({ graceMs: 30 });
    await manager.enter(ctx('p1'), 'u1');
    manager.leave('p1', 'u1');
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
    expect(provider.stopCalls).toEqual(['p1']);
    expect(beforeStopLog).toEqual(['p1']);
  });

  test('erneutes Betreten innerhalb der Grace-Period verhindert den Stopp', async () => {
    const { provider, manager } = setup({ graceMs: 60 });
    await manager.enter(ctx('p1'), 'u1');
    manager.leave('p1', 'u1');
    await Bun.sleep(20);
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
    expect(provider.startCalls).toEqual(['p1']);
  });

  test('Grace-Stopp wird aufgeschoben, solange ein Turn läuft', async () => {
    let busy = true;
    const { provider, manager } = setup({ graceMs: 20, isBusy: () => busy });
    await manager.enter(ctx('p1'), 'u1');
    manager.leave('p1', 'u1');

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
    await manager.enter(ctx('p1'), 'u1');
    manager.leave('p1', 'u1');
    await Bun.sleep(50);
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(90);
    // Wieder betreten: Grace ist abgeräumt, busy spielt keine Rolle mehr.
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
  });
});

describe('Agent-Idle (R9, 30-min-Regel)', () => {
  test('stoppt bei Agent-Inaktivität auch ohne leave', async () => {
    const { manager } = setup({ idleMs: 40 });
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
  });

  test('Agent-Aktivität verschiebt den Idle-Stopp', async () => {
    const { manager } = setup({ idleMs: 60 });
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(30);
    manager.noteAgentActivity('p1');
    await Bun.sleep(40);
    expect(manager.status('p1')).toBe('running');
    await Bun.sleep(60);
    expect(manager.status('p1')).toBe('stopped');
  });
});

/**
 * F17: `enter` kurzschloss nur bei starting/running. Ein Eintrag im Status
 * `stopping` — während stop() noch auf den Auto-Commit-Hook wartet — wurde
 * ersetzt und eine neue VM unter demselben msb-Namen gestartet; das alte
 * stop() räumte danach die NEUE VM ab.
 */
describe('enter wartet auf ein laufendes stop (F17)', () => {
  test('startet erst neu, wenn der Stopp samt Auto-Commit durch ist', async () => {
    // Kein Nullable: TS würde die Zuweisung in der Closure nicht sehen.
    let releaseStop = (): void => {};
    const { provider, manager, beforeStopLog } = setup({
      graceMs: 10_000,
    });
    // onBeforeStop künstlich verzögern (steht für den Auto-Commit).
    const slowManager = manager as unknown as {
      options: { onBeforeStop?: (id: string) => Promise<void> };
    };
    const original = slowManager.options.onBeforeStop;
    slowManager.options.onBeforeStop = async (id) => {
      await original?.(id);
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    };

    await manager.enter(ctx('p1'), 'u1');
    const stopping = manager.stop('p1');
    await Bun.sleep(10);
    expect(manager.status('p1')).toBe('stopping');

    const entering = manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(10);
    // Solange der Stopp hängt, darf kein zweiter Start passiert sein.
    expect(provider.startCalls).toEqual(['p1']);

    releaseStop();
    await stopping;
    await entering;

    expect(provider.startCalls).toEqual(['p1', 'p1']);
    expect(beforeStopLog).toEqual(['p1']);
    expect(manager.status('p1')).toBe('running');
  });
});

describe('stopAll', () => {
  test('stoppt alle laufenden Sandboxes', async () => {
    const { provider, manager } = setup();
    await manager.enter(ctx('p1'), 'u1');
    await manager.enter(ctx('p2'), 'u1');
    await manager.stopAll();
    expect(manager.status('p1')).toBe('stopped');
    expect(manager.status('p2')).toBe('stopped');
    expect(provider.stopCalls.sort()).toEqual(['p1', 'p2']);
  });
});

/**
 * 2. Scan, F14: Der neue Eintrag lag als `stopped` in der Map, während enter()
 * bereits awaitete. Ein zweiter, gleichzeitiger enter() erkannte ihn nicht als
 * startend, legte einen eigenen an und startete dieselbe Sandbox ein zweites
 * Mal — zwei VMs unter demselben msb-Namen und zwei ausgestellte VM-Tokens.
 */
describe('gleichzeitiges enter startet nur EINE Sandbox (F14)', () => {
  test('drei parallele Aufrufe ergeben genau einen Provider-Start', async () => {
    let starts = 0;
    const provider: SandboxProvider = {
      async start(): Promise<SandboxHandle> {
        starts += 1;
        await Bun.sleep(30);
        return { previewHostPort: 1, previewStatus: () => 'ready' as const, stop: async () => {} };
      },
    };
    const manager = new SandboxManager({
      provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
    });

    await Promise.all([
      manager.enter(ctx('p1'), 'u1'),
      manager.enter(ctx('p1'), 'u1'),
      manager.enter(ctx('p1'), 'u1'),
    ]);

    expect(starts).toBe(1);
    expect(manager.status('p1')).toBe('running');
  });
});

describe('detachForReload (Dev-Hot-Reload)', () => {
  test('entschärft einen scharfen Grace-Timer, ohne die Sandbox zu stoppen', async () => {
    const { provider, manager } = setup({ graceMs: 20, idleMs: 10_000 });
    await manager.enter(ctx('p1'), 'u1');
    manager.leave('p1', 'u1'); // letzter Betrachter weg → Grace scharf
    manager.detachForReload();
    await Bun.sleep(60);
    expect(provider.stopCalls).toEqual([]);
    expect(manager.status('p1')).toBe('running');
  });

  test('entschärft den Idle-Timer, ohne die Sandbox zu stoppen', async () => {
    const { provider, manager } = setup({ graceMs: 10_000, idleMs: 20 });
    await manager.enter(ctx('p1'), 'u1');
    manager.detachForReload();
    await Bun.sleep(60);
    expect(provider.stopCalls).toEqual([]);
    expect(manager.status('p1')).toBe('running');
  });
});

/**
 * N6 aus dem Zustandsmaschinen-Audit: previewStatus() lieferte während des
 * Boots hart „stopped" (Gate: status !== 'running' || !handle) — das Overlay
 * behauptete „Sandbox gestoppt", während die Preview gerade STARTETE.
 */
describe('previewStatus während des Boots (N6)', () => {
  test('meldet „starting", solange die Sandbox startet — danach den echten Handle-Status', async () => {
    const t = torProvider();
    const manager = new SandboxManager({
      provider: t.provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
    });

    const start = manager.enter(ctx('p1'), 'u1');
    await t.warteAufTor('p1');
    expect(manager.status('p1')).toBe('starting');
    expect(manager.previewStatus('p1')).toBe('starting');

    t.freigeben('p1');
    await start;
    expect(manager.previewStatus('p1')).toBe('ready');
  });

  test('unbekanntes Projekt und gestoppte Sandbox bleiben „stopped"', async () => {
    const { manager } = setup();
    expect(manager.previewStatus('unbekannt')).toBe('stopped');
    await manager.enter(ctx('p1'), 'u1');
    await manager.stop('p1');
    expect(manager.previewStatus('p1')).toBe('stopped');
  });
});

/**
 * N7 aus dem Zustandsmaschinen-Audit: msb startet Sandboxes mit .replace() —
 * eine nach einem Hot-Reload verwaiste, noch laufende VM gleichen Namens wird
 * beim nächsten Start kommentarlos ÜBERBOOTET, ohne stop(), also ohne den
 * onBeforeStop-Auto-Commit. Ihr Workspace-Stand (Host-Mount) ginge zwar nicht
 * verloren, bliebe aber uncommittet. Der onBeforeStart-Hook sichert ihn,
 * BEVOR provider.start die alte VM ersetzt (autoCommit ist bei leerem
 * git status ein No-op — der Normalfall kostet ein git status).
 */
describe('onBeforeStart: offener Stand wird gesichert, bevor eine neue VM bootet (N7)', () => {
  function setupMitBeforeStart(onBeforeStart: (projectId: string) => Promise<void>) {
    const ablauf: string[] = [];
    const provider: SandboxProvider = {
      async start(context: SandboxContext): Promise<SandboxHandle> {
        ablauf.push(`start:${context.projectId}`);
        return {
          previewHostPort: 1,
          previewStatus: () => 'ready' as const,
          stop: async () => {},
        };
      },
    };
    const manager = new SandboxManager({
      provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
      onBeforeStart: async (projectId) => {
        ablauf.push(`beforeStart:${projectId}`);
        await onBeforeStart(projectId);
      },
    });
    return { ablauf, manager };
  }

  test('läuft beim Frischstart VOR provider.start', async () => {
    const { ablauf, manager } = setupMitBeforeStart(async () => {});
    await manager.enter(ctx('p1'), 'u1');
    expect(ablauf).toEqual(['beforeStart:p1', 'start:p1']);
  });

  test('ein No-op-enter auf laufender VM ruft den Hook nicht erneut', async () => {
    const { ablauf, manager } = setupMitBeforeStart(async () => {});
    await manager.enter(ctx('p1'), 'u1');
    await manager.enter(ctx('p1'), 'u2');
    await manager.ensureRunning(ctx('p1'));
    expect(ablauf).toEqual(['beforeStart:p1', 'start:p1']);
  });

  test('ein Fehler im Hook blockiert den Start nicht', async () => {
    const { ablauf, manager } = setupMitBeforeStart(async () => {
      throw new Error('git kaputt');
    });
    await manager.enter(ctx('p1'), 'u1');
    expect(manager.status('p1')).toBe('running');
    expect(ablauf).toEqual(['beforeStart:p1', 'start:p1']);
  });
});
