import { describe, expect, test } from 'bun:test';
import type { SandboxHandle, SandboxProvider } from '../provider';
import { SandboxManager, viewerKey } from '../sandboxManager';
import { ctx, setup } from './sandboxManagerFixtures';

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
