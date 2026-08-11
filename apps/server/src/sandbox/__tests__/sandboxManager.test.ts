import { describe, expect, test } from 'bun:test';
import type { SandboxContext, SandboxHandle, SandboxProvider } from '../provider';
import { SandboxManager, viewerKey } from '../sandboxManager';

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
    // Der Angriff: leave ist ownership-frei (R10, auch Besucher-Subscriptions
    // zaehlen). Ohne Refcount stellte ein einzelnes fremdes leave den
    // Grace-Timer scharf und stoppte damit die VM des Eigentümers — samt
    // Auto-Commit in dessen Branch.
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

/**
 * Der Betrachter-Refcount (H11) war nach NUTZER-ID verschluesselt. Oeffnet
 * dieselbe Person dasselbe Projekt in zwei Tabs (oder auf Laptop und iPad),
 * fuegt der zweite Eintritt nichts hinzu — das Set hat weiterhin ein Element.
 * Schliesst sie den ersten Tab, leert `leave` das Set und stellt Grace scharf:
 * die VM stirbt unter dem noch offenen zweiten Tab, die Preview kippt auf
 * „nicht bereit", und der naechste Prompt zahlt einen Kaltstart.
 */
describe('viewerKey: eine Identitaet pro Subscription, nicht pro Nutzer', () => {
  test('trennt zwei Subscriptions desselben Nutzers', () => {
    expect(viewerKey('u1', 'tab-a')).not.toBe(viewerKey('u1', 'tab-b'));
  });

  test('bleibt fuer dieselbe Verbindung stabil', () => {
    expect(viewerKey('u1', 'tab-a')).toBe(viewerKey('u1', 'tab-a'));
  });

  test('zwei Tabs halten die Sandbox offen, bis beide gegangen sind', async () => {
    const { manager, provider } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), viewerKey('marco', 'tab-a'));
    await manager.enter(ctx('p1'), viewerKey('marco', 'tab-b'));

    manager.leave('p1', viewerKey('marco', 'tab-a'));
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);

    manager.leave('p1', viewerKey('marco', 'tab-b'));
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
  });
});

/**
 * Die drei Lebenszyklus-Rennen aus dem zweiten Review — allesamt in Fixes des
 * ERSTEN Reviews eingeschleppt.
 */

/** Provider, dessen Start an einem Gate haengt, bis man ihn freigibt. */
function torProvider() {
  const tore = new Map<string, () => void>();
  const gestoppt: string[] = [];
  const provider: SandboxProvider = {
    async start(context: SandboxContext): Promise<SandboxHandle> {
      await new Promise<void>((resolve) => tore.set(context.projectId, resolve));
      return {
        previewHostPort: 1,
        previewStatus: () => 'ready' as const,
        stop: async () => {
          gestoppt.push(context.projectId);
        },
      };
    },
  };
  return {
    provider,
    gestoppt,
    freigeben: (projectId: string) => tore.get(projectId)?.(),
    warteAufTor: async (projectId: string) => {
      for (let i = 0; i < 200 && !tore.has(projectId); i += 1) await Bun.sleep(2);
    },
  };
}

describe('SandboxManager-Lebenszyklus: Rennen aus dem zweiten Review', () => {
  test('#3 zwei parallele enter() bei vollem Limit deadlocken nicht', async () => {
    // maxSandboxes=1: waehrend A startet, will B einen Platz. Die Eviction darf
    // die startende A NICHT als Opfer waehlen und in stop() auf deren
    // startPromise warten — sonst warten A und B im schlimmsten Fall
    // wechselseitig aufeinander. Der Lauf MUSS in endlicher Zeit terminieren.
    const t = torProvider();
    const manager = new SandboxManager({
      provider: t.provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 1,
    });

    const eintritte = Promise.allSettled([
      manager.enter(ctx('A'), 'u1'),
      manager.enter(ctx('B'), 'u2'),
    ]);
    await t.warteAufTor('A');
    t.freigeben('A');
    t.freigeben('B');

    // Ohne Fix haengt das hier ewig. Mit Fix terminiert es (B ggf. mit
    // CapacityError, weil der einzige Platz von der startenden A belegt ist).
    const ergebnisse = await Promise.race([
      eintritte,
      Bun.sleep(3000).then(() => 'timeout' as const),
    ]);
    expect(ergebnisse).not.toBe('timeout');
  });

  test('#8 enter() waehrend eines Stopps haengt sich nicht an den sterbenden Start', async () => {
    // stop() wartet auf das startPromise. Setzt es den Status erst NACH dem
    // await auf stopping, sieht ein paralleles enter() in diesem Fenster noch
    // starting und haengt sich an den gerade sterbenden Start — statt auf den
    // Stopp zu warten und danach frisch zu starten.
    const t = torProvider();
    const manager = new SandboxManager({
      provider: t.provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
    });

    const ersterEintritt = manager.enter(ctx('p1'), 'u1');
    await t.warteAufTor('p1');

    // Stopp anfordern, waehrend p1 noch startet.
    const stopp = manager.stop('p1');
    // Sofort ein zweiter Eintritt — er darf sich NICHT an den sterbenden Start
    // haengen, sondern muss den Stopp abwarten und neu starten.
    const zweiterEintritt = manager.enter(ctx('p1'), 'u2');

    // Ersten Start durchlaufen lassen; der Stopp raeumt ihn ab.
    t.freigeben('p1');
    await Promise.allSettled([ersterEintritt, stopp]);

    // Jetzt haengt der zweite Eintritt an einem NEUEN Start — freigeben.
    await t.warteAufTor('p1');
    t.freigeben('p1');
    await zweiterEintritt;

    // Der zweite Eintritt sieht eine laufende Sandbox, nicht eine gestoppte.
    expect(manager.status('p1')).toBe('running');
    // Und die erste VM wurde wirklich gestoppt.
    expect(t.gestoppt).toContain('p1');
  });

  test('#9 forget() verwaist keine VM, die zwischen stop() und forget() neu startet', async () => {
    const t = torProvider();
    const manager = new SandboxManager({
      provider: t.provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
    });

    // p1 laeuft.
    const start1 = manager.enter(ctx('p1'), 'u1');
    await t.warteAufTor('p1');
    t.freigeben('p1');
    await start1;

    // deleteProject-Reihenfolge: stop(), dann forget(). Dazwischen kommt ein
    // enter() und startet die VM neu.
    await manager.stop('p1');
    const neuerStart = manager.enter(ctx('p1'), 'u2');
    await t.warteAufTor('p1');

    manager.forget('p1');

    t.freigeben('p1');
    await neuerStart;

    // forget() darf die neu gestartete VM nicht aus der Buchhaltung werfen —
    // sonst laeuft sie ohne Handle zum Stoppen weiter.
    expect(manager.status('p1')).not.toBe('stopped');
    expect(manager.trackedProjects()).toBe(1);
  });
});

/**
 * #2/#7, dritter Anlauf: Der Refcount wird von der LEBENSDAUER der
 * chatEvents-Subscription getrieben — enter beim Aufbau, leave im finally des
 * Iterators. Damit ist die Set-Groesse durch die tatsaechlich lebenden
 * Subscriptions begrenzt, und die fruehere LRU-Obergrenze (MAX_VIEWERS) ist
 * nicht nur unnoetig, sondern war SCHAEDLICH: verdraengte sie einen noch
 * lebenden Betrachter, wurde dessen leave zum No-op — der Refcount fiel nie
 * auf 0 und die VM stoppte NIE.
 */
describe('Refcount = lebende Subscriptions (H11): keine LRU-Verdraengung', () => {
  test('ein lebender Betrachter wird nie verdraengt, auch nicht von vielen anderen', async () => {
    const { manager, provider } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'lebender-tab');
    // Viele kurzlebige Betrachter kommen und gehen wieder (Subscriptions, die
    // sauber schliessen). Mit der LRU flog 'lebender-tab' aus dem Set: nach dem
    // letzten kurzlebigen leave war das Set leer, Grace feuerte, und die VM
    // starb unter dem noch offenen Tab.
    for (let i = 0; i < 200; i += 1) {
      await manager.enter(ctx('p1'), `kurz-${i}`);
    }
    for (let i = 0; i < 200; i += 1) {
      manager.leave('p1', `kurz-${i}`);
    }
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);

    // Erst wenn auch der lebende Betrachter geht, greift Grace.
    manager.leave('p1', 'lebender-tab');
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
    expect(provider.stopCalls).toEqual(['p1']);
  });

  test('die Set-Groesse entspricht exakt den lebenden Betrachtern', async () => {
    const { manager } = setup({ graceMs: 10_000 });
    for (let i = 0; i < 500; i += 1) {
      await manager.enter(ctx('p1'), `sub-${i}`);
    }
    // KEINE Verdraengung: alle 500 leben (ihre Subscriptions sind offen) und
    // zaehlen. Das Wachstum ist durch offene Verbindungen begrenzt, nicht
    // durch eine Obergrenze im Manager.
    expect(manager.viewerCount('p1')).toBe(500);
    for (let i = 0; i < 500; i += 1) {
      manager.leave('p1', `sub-${i}`);
    }
    expect(manager.viewerCount('p1')).toBe(0);
  });
});

/**
 * Defekt 2 (H11): Die Betrachter-Eintraege gehoeren zur Lebensdauer der
 * SUBSCRIPTION, nicht der VM. Eine offene Subscription ueberlebt einen
 * VM-Stopp (der SSE-Stream reisst dabei nicht ab) und traegt sich danach nie
 * erneut ein: enter() laeuft genau einmal beim Aufbau, ensureRunning zaehlt
 * bewusst nicht. Leerte stop() das Set, stoppte ein spaeterer Neustart die VM
 * per Grace UNTER dem noch offenen, zuschauenden Tab.
 */
describe('Betrachter ueberleben einen VM-Stopp (H11, Defekt 2)', () => {
  test('nach Idle-Stopp + ensureRunning ist Grace NICHT scharf, solange der Betrachter lebt', async () => {
    const { manager, provider } = setup({ graceMs: 20, idleMs: 10_000 });
    await manager.enter(ctx('p1'), 'tab-1');
    // 30-min-Idle-Stopp bei offenem Tab — die Subscription lebt weiter.
    await manager.stop('p1');
    expect(manager.status('p1')).toBe('stopped');
    expect(manager.viewerCount('p1')).toBe(1);

    // User schickt eine Nachricht → sendMessage startet die VM via ensureRunning.
    await manager.ensureRunning(ctx('p1'));
    await Bun.sleep(120);
    // Ohne Fix: viewers wurde bei stop() geleert, ensureRunning sah 0
    // Betrachter, Grace wurde scharf und stoppte die VM unter dem offenen Tab.
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual(['p1']); // nur der Idle-Stopp

    // Erst das garantierte leave der Subscription (releaseOnClose) gibt frei.
    manager.leave('p1', 'tab-1');
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
    expect(provider.stopCalls).toEqual(['p1', 'p1']);
  });

  test('geht der Betrachter, WAEHREND die VM gestoppt ist, zaehlt er beim Neustart nicht mehr', async () => {
    const { manager } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'tab-1');
    await manager.stop('p1');

    // Tab schliesst bei gestoppter VM: das leave muss den Eintrag TROTZDEM
    // austragen — sonst zaehlte ein toter Betrachter beim Neustart weiter und
    // die VM liefe bis zum Idle-Stopp, obwohl niemand mehr zusieht.
    manager.leave('p1', 'tab-1');
    expect(manager.viewerCount('p1')).toBe(0);

    await manager.ensureRunning(ctx('p1'));
    await Bun.sleep(120);
    // Invariante nach Neustart: 0 Betrachter ⇒ Grace laeuft und stoppt.
    expect(manager.status('p1')).toBe('stopped');
  });

  test('auch ein enter() nach dem Stopp uebernimmt die ueberlebenden Betrachter', async () => {
    const { manager } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'tab-1');
    await manager.stop('p1');

    // Ein zweiter Tab oeffnet nach dem Stopp: beide Betrachter zaehlen.
    await manager.enter(ctx('p1'), 'tab-2');
    expect(manager.viewerCount('p1')).toBe(2);

    manager.leave('p1', 'tab-2');
    await Bun.sleep(120);
    // tab-1 lebt noch — kein Stopp.
    expect(manager.status('p1')).toBe('running');

    manager.leave('p1', 'tab-1');
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
  });

  test('ein gescheiterter enter() hinterlaesst keinen Betrachter-Eintrag', async () => {
    // Scheitert der Start, kommt die Subscription nie zustande — ihr
    // garantiertes leave (releaseOnClose) wird also nie installiert. Da die
    // Betrachter jetzt VM-Stopps ueberleben, muss enter() seinen Eintrag
    // SELBST zuruecknehmen, sonst zaehlte ein toter Betrachter beim naechsten
    // Start weiter und die VM liefe ohne Zuschauer bis zum Idle-Stopp.
    let scheitern = true;
    const provider: SandboxProvider = {
      async start(): Promise<SandboxHandle> {
        if (scheitern) throw new Error('msb antwortet nicht');
        return { previewHostPort: 1, previewStatus: () => 'ready' as const, stop: async () => {} };
      },
    };
    const manager = new SandboxManager({ provider, graceMs: 20, idleMs: 10_000, maxSandboxes: 8 });

    await expect(manager.enter(ctx('p1'), 'tab-1')).rejects.toThrow('msb antwortet nicht');
    expect(manager.viewerCount('p1')).toBe(0);

    // Der naechste Start (ohne Betrachter) muss deshalb per Grace stoppen.
    scheitern = false;
    await manager.ensureRunning(ctx('p1'));
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
  });

  test('auch ein enter(), das sich an einen scheiternden Start haengt, traegt sich wieder aus', async () => {
    let startFreigeben = (): void => {};
    const startLaeuft = new Promise<void>((resolve) => {
      startFreigeben = resolve;
    });
    const provider: SandboxProvider = {
      async start(): Promise<SandboxHandle> {
        await startLaeuft;
        throw new Error('msb antwortet nicht');
      },
    };
    const manager = new SandboxManager({ provider, graceMs: 20, idleMs: 10_000, maxSandboxes: 8 });

    const erster = manager.enter(ctx('p1'), 'tab-1');
    await Bun.sleep(10);
    const zweiter = manager.enter(ctx('p1'), 'tab-2');
    await Bun.sleep(10);
    startFreigeben();

    // Beide gemeinsam einsammeln — sonst steht die Rejection des zweiten
    // waehrend des ersten awaits kurz ohne Handler da (Unhandled Rejection).
    const ergebnisse = await Promise.allSettled([erster, zweiter]);
    expect(ergebnisse.map((e) => e.status)).toEqual(['rejected', 'rejected']);
    expect(manager.viewerCount('p1')).toBe(0);
  });
});

/**
 * enterProject/sendMessage duerfen die Sandbox weiterhin EAGER starten (die
 * Preview soll laden, bevor die Subscription offen ist) — aber OHNE einen
 * Betrachter zu zaehlen: der Refcount gehoert allein der Subscription, deren
 * Ende das einzige verlaessliche "Betrachter ist gegangen"-Signal ist.
 */
describe('ensureRunning: Eager-Start ohne Betrachter (enterProject/sendMessage)', () => {
  test('startet die Sandbox, zaehlt aber keinen Betrachter', async () => {
    const { manager, provider } = setup({ graceMs: 10_000 });
    await manager.ensureRunning(ctx('p1'));
    expect(manager.status('p1')).toBe('running');
    expect(provider.startCalls).toEqual(['p1']);
    expect(manager.viewerCount('p1')).toBe(0);
  });

  test('ohne nachfolgende Subscription stoppt Grace die Sandbox wieder', async () => {
    // Der Missbrauchsfall aus #2: enterProject in einer Schleife auf ein
    // fremdes Projekt darf die VM nicht dauerhaft offen pinnen — ohne lebende
    // Subscription faellt sie nach der Grace-Period zurueck in den Stopp.
    const { manager, provider } = setup({ graceMs: 20 });
    await manager.ensureRunning(ctx('p1'));
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('stopped');
    expect(provider.stopCalls).toEqual(['p1']);
  });

  test('eine Subscription innerhalb der Grace-Period haelt die Sandbox am Leben', async () => {
    const { manager, provider } = setup({ graceMs: 40 });
    await manager.ensureRunning(ctx('p1'));
    await manager.enter(ctx('p1'), 'sub-1');
    await Bun.sleep(150);
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
  });

  test('stoert vorhandene Betrachter nicht', async () => {
    const { manager, provider } = setup({ graceMs: 20 });
    await manager.enter(ctx('p1'), 'sub-1');
    await manager.ensureRunning(ctx('p1'));
    await Bun.sleep(120);
    expect(manager.status('p1')).toBe('running');
    expect(provider.stopCalls).toEqual([]);
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
