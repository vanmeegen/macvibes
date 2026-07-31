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

describe('Betrachter-Refcount (H11): nur der letzte Betrachter stellt Grace scharf', () => {
  test('ein Fremder kann die Sandbox nicht stoppen, während der Eigentümer zusieht', async () => {
    // Der Angriff: leaveProject ist ownership-frei (R10). Ohne Refcount stellte
    // ein einzelner fremder Aufruf den Grace-Timer scharf und stoppte damit die
    // VM des Eigentümers — samt Auto-Commit in dessen Branch.
    const { provider, manager, beforeStopLog } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'eigentuemer');
    await manager.enter(ctx('p1'), 'fremder');

    manager.leave('p1', 'fremder');
    await Bun.sleep(120);

    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
    expect(beforeStopLog).toEqual([]);
  });

  test('ein leave für einen nie eingetretenen Betrachter bewirkt nichts', async () => {
    const { provider, manager } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'eigentuemer');

    manager.leave('p1', 'niemals-eingetreten');
    await Bun.sleep(120);

    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
  });

  test('geht der letzte Betrachter, greift die Grace-Period wie bisher', async () => {
    const { provider, manager, beforeStopLog } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'eigentuemer');
    await manager.enter(ctx('p1'), 'fremder');

    manager.leave('p1', 'fremder');
    manager.leave('p1', 'eigentuemer');
    await Bun.sleep(120);

    expect(manager.status('p1')).toBe('stopped');
    expect(provider.stopCalls).toEqual(['p1']);
    expect(beforeStopLog).toEqual(['p1']);
  });

  test('mehrfaches leave desselben Betrachters stoppt nicht doppelt', async () => {
    const { provider, manager } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'eigentuemer');
    await manager.enter(ctx('p1'), 'fremder');

    manager.leave('p1', 'fremder');
    manager.leave('p1', 'fremder');
    await Bun.sleep(120);

    // Der Eigentümer ist noch da — kein Stopp.
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
  });

  test('nach einem Neustart zählt der Betrachterstand von vorn', async () => {
    const { manager } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'eigentuemer');
    manager.leave('p1', 'eigentuemer');
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');

    await manager.enter(ctx('p1'), 'fremder');
    expect(manager.status('p1')).toBe('running');
    // Der alte Eigentümer-Eintrag darf nicht überlebt haben.
    manager.leave('p1', 'fremder');
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
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

describe('LRU-Limit (R9, max Sandboxes)', () => {
  test('stoppt die am längsten inaktive Sandbox beim Überschreiten', async () => {
    const { provider, manager } = setup({ maxSandboxes: 2, graceMs: 10_000 });
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(5);
    await manager.enter(ctx('p2'), 'u1');
    await Bun.sleep(5);
    manager.noteAgentActivity('p1');
    await manager.enter(ctx('p3'), 'u1');

    // p2 ist am längsten inaktiv → wird verdrängt; p1 und p3 laufen.
    expect(manager.status('p2')).toBe('stopped');
    expect(manager.status('p1')).toBe('running');
    expect(manager.status('p3')).toBe('running');
    expect(provider.stopCalls).toEqual(['p2']);
  });
});

/**
 * F20: `enter` ist über den bewusst ungeschützten enterProject-Resolver für
 * JEDES Projekt erreichbar. Die Eviction kannte weder Eigentümer noch
 * `isBusy` — ein Nutzer konnte die Plätze mit fremden Projekten füllen und
 * dabei laufende Turns anderer beenden.
 */
describe('LRU-Eviction schont beschäftigte Sandboxes (F20)', () => {
  test('verdrängt keine Sandbox mit laufendem Turn, sondern lehnt ab', async () => {
    const { provider, manager } = setup({
      maxSandboxes: 1,
      graceMs: 10_000,
      isBusy: (id) => id === 'p1',
    });
    await manager.enter(ctx('p1'), 'u1');

    await expect(manager.enter(ctx('p2'), 'u1')).rejects.toThrow(/belegt|beschäftigt/i);

    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
  });

  test('eine untätige Sandbox wird weiterhin verdrängt', async () => {
    const { provider, manager } = setup({
      maxSandboxes: 1,
      graceMs: 10_000,
      isBusy: () => false,
    });
    await manager.enter(ctx('p1'), 'u1');
    await manager.enter(ctx('p2'), 'u1');

    expect(provider.stopCalls).toEqual(['p1']);
    expect(manager.status('p2')).toBe('running');
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

/**
 * ADR 0003: Die VM bekommt eine eigene Idle-Frist als Auffangnetz für den Fall,
 * dass der Host stirbt. Damit sie im Normalbetrieb nie zuschlägt, stößt jeder
 * host-seitige touch() zusätzlich einen touch() auf der Sandbox an — gedrosselt,
 * weil noteAgentActivity bei JEDEM Agent-Event feuert.
 */
describe('VM-Idle-Auffangnetz (ADR 0003)', () => {
  function setupMitVmTouch(overrides: { vmTouchIntervalMs?: number } = {}) {
    const provider = new FakeProvider();
    const beruehrt: string[] = [];
    const manager = new SandboxManager({
      provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
      touchSandbox: async (name) => {
        beruehrt.push(name);
      },
      ...(overrides.vmTouchIntervalMs !== undefined
        ? { vmTouchIntervalMs: overrides.vmTouchIntervalMs }
        : {}),
    });
    return { manager, beruehrt };
  }

  test('berührt die VM beim Betreten', async () => {
    const { manager, beruehrt } = setupMitVmTouch();
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(20);
    expect(beruehrt).toEqual(['p1']);
  });

  test('drosselt: viele Agent-Events ergeben nicht viele VM-Berührungen', async () => {
    // Der eigentliche Fallstrick: onAgentActivity feuert pro Text-Delta.
    const { manager, beruehrt } = setupMitVmTouch({ vmTouchIntervalMs: 60_000 });
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(20);
    const nachStart = beruehrt.length;

    for (let i = 0; i < 200; i += 1) manager.noteAgentActivity('p1');
    await Bun.sleep(20);

    expect(beruehrt.length).toBe(nachStart);
  });

  test('berührt wieder, sobald das Drossel-Intervall abgelaufen ist', async () => {
    const { manager, beruehrt } = setupMitVmTouch({ vmTouchIntervalMs: 30 });
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(20);
    const nachStart = beruehrt.length;

    await Bun.sleep(50);
    manager.noteAgentActivity('p1');
    await Bun.sleep(20);

    expect(beruehrt.length).toBe(nachStart + 1);
  });

  test('ein Fehler beim VM-Touch bricht den Turn nicht ab', async () => {
    // Ein hängendes msb darf niemals einen laufenden Turn stören.
    const provider = new FakeProvider();
    const manager = new SandboxManager({
      provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
      touchSandbox: async () => {
        throw new Error('msb antwortet nicht');
      },
    });
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(20);
    manager.noteAgentActivity('p1');
    await Bun.sleep(20);
    expect(manager.status('p1')).toBe('running');
  });

  test('ohne touchSandbox verhält sich der Manager wie bisher', async () => {
    const { provider, manager } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'u1');
    manager.noteAgentActivity('p1');
    expect(manager.status('p1')).toBe('running');
    expect(provider.startCalls).toEqual(['p1']);
  });
});

/**
 * Ein Eintrag wurde nie aus der Tabelle entfernt: Kontext, Betrachter-Set und
 * Timer eines gestoppten Projekts blieben fuer die Lebensdauer des Prozesses
 * liegen — auch fuer Projekte, die es gar nicht mehr gibt.
 */
describe('forget: geloeschte Projekte nicht ewig mitschleppen', () => {
  test('entfernt den Eintrag samt Timern', async () => {
    const { manager } = setup();
    await manager.enter(ctx('p1'), 'marco');
    expect(manager.trackedProjects()).toBe(1);

    await manager.stop('p1');
    manager.forget('p1');

    expect(manager.trackedProjects()).toBe(0);
    expect(manager.status('p1')).toBe('stopped');
  });

  test('ist folgenlos fuer ein unbekanntes Projekt', () => {
    const { manager } = setup();
    expect(() => manager.forget('gibt-es-nicht')).not.toThrow();
    expect(manager.trackedProjects()).toBe(0);
  });
});
