import { describe, expect, test } from 'bun:test';
import type { SandboxContext, SandboxHandle, SandboxProvider } from '../provider';
import { SandboxManager } from '../sandboxManager';
import { waitFor } from '../../testing/testUtils';
import { ctx, FakeProvider, setup, torProvider } from './sandboxManagerFixtures';

/**
 * Die drei Lebenszyklus-Rennen aus dem zweiten Review — allesamt in Fixes des
 * ERSTEN Reviews eingeschleppt.
 */

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
 * M2 aus dem Zustandsmaschinen-Audit: Starb die MicroVM oder unmonitorte monit
 * den Dev-Server (Crash-Loop → previewStatus „failed"), blieb der
 * Manager-Eintrag „running" und ensureRunning war ein No-op — es gab KEINEN
 * Heilungspfad, der UI-Hinweis „bitte das Projekt neu öffnen" war wirkungslos.
 * Jetzt heilt das Wieder-Öffnen: der running-Zweig erkennt eine kaputte VM
 * (previewStatus „failed" oder vom VM-Touch als verschwunden gemeldet) und
 * macht einen ordentlichen Stop→Neustart — außer ein Turn läuft (isBusy).
 */
describe('Heilung beim Wieder-Öffnen: kaputte VM bei Manager-Status running (M2)', () => {
  test('enter auf running-Eintrag mit previewStatus „failed": Stop (inkl. Auto-Commit) → Neustart', async () => {
    const { provider, manager, beforeStopLog } = setup({ graceMs: 10_000 });
    await manager.enter(ctx('p1'), 'u1');
    provider.previewStatusVon.set('p1', 'failed');

    await manager.enter(ctx('p1'), 'u1');

    expect(provider.stopCalls).toEqual(['p1']);
    expect(provider.startCalls).toEqual(['p1', 'p1']);
    // Der Heil-Stopp ist ein ORDENTLICHER Stopp: Auto-Commit lief.
    expect(beforeStopLog).toContain('p1');
    expect(manager.status('p1')).toBe('running');
    // H11: der Betrachter überlebt die Heilung.
    expect(manager.viewerCount('p1')).toBe(1);
  });

  test('kein Heil-Neustart, solange ein Turn läuft (isBusy)', async () => {
    const { provider, manager } = setup({ graceMs: 10_000, isBusy: () => true });
    await manager.enter(ctx('p1'), 'u1');
    provider.previewStatusVon.set('p1', 'failed');

    await manager.enter(ctx('p1'), 'u1');

    expect(provider.stopCalls).toEqual([]);
    expect(provider.startCalls).toEqual(['p1']);
    expect(manager.status('p1')).toBe('running');
  });

  test('eine vom VM-Touch als verschwunden gemeldete VM wird beim nächsten enter neu gestartet', async () => {
    const provider = new FakeProvider();
    let vorhanden = true;
    const manager = new SandboxManager({
      provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
      vmTouchIntervalMs: 0,
      touchSandbox: async () => vorhanden,
    });
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(10);

    // Die VM stirbt (msb kennt sie nicht mehr) — der nächste Touch meldet das.
    vorhanden = false;
    manager.noteAgentActivity('p1');
    await Bun.sleep(10);

    await manager.enter(ctx('p1'), 'u1');
    expect(provider.startCalls).toEqual(['p1', 'p1']);
    expect(manager.status('p1')).toBe('running');
  });

  test('gesunde VM bleibt beim Wieder-Öffnen unangetastet (kein Über-Eifer)', async () => {
    const { provider, manager } = setup({ graceMs: 10_000 });
    await manager.enter(ctx('p1'), 'u1');

    for (const status of ['ready', 'starting', 'restarting'] as const) {
      provider.previewStatusVon.set('p1', status);
      await manager.enter(ctx('p1'), 'u1');
    }

    expect(provider.stopCalls).toEqual([]);
    expect(provider.startCalls).toEqual(['p1']);
  });
});

/**
 * Zombie-Timer: Die Timer-Callbacks schließen über ihr `entry`-Objekt, rufen
 * aber `this.stop(projectId)` — also „was auch immer gerade unter dieser ID
 * registriert ist". Bleibt ein Timer an einem TOTEN Eintrag hängen, stoppt er
 * beim Ablauf die inzwischen neu gestartete, GESUNDE VM. `forget()` hat für
 * genau diese Klasse seit N8 einen Same-Object-Guard — die Timer nicht.
 */
describe('Zombie-Timer eines toten Eintrags darf die nächste VM nicht stoppen', () => {
  test('Grace-Timer eines GESCHEITERTEN Starts killt die danach gesunde VM nicht', async () => {
    // Der Weg dorthin ist Alltag: Betrachter öffnet, der Kaltstart läuft,
    // der Tab geht zu (leave armiert Grace auch im Status „starting"), und
    // dann scheitert der Start (Kapazität, msb-Flake, fehlende Baseline).
    // Der Fehlerpfad setzte nur den Status, ließ den Timer aber laufen.
    let versuch = 0;
    let freigeben: () => void = () => {};
    const tor = new Promise<void>((r) => {
      freigeben = r;
    });
    const gestoppt: string[] = [];
    const provider: SandboxProvider = {
      async start(context: SandboxContext): Promise<SandboxHandle> {
        versuch += 1;
        if (versuch === 1) {
          await tor;
          throw new Error('Startfehler (Kapazität/msb-Flake)');
        }
        return {
          previewHostPort: 1,
          previewStatus: () => 'ready' as const,
          stop: async () => {
            gestoppt.push(context.projectId);
          },
        };
      },
    };
    const manager = new SandboxManager({
      provider,
      graceMs: 60,
      idleMs: 10_000,
      maxSandboxes: 8,
    });

    const ersterStart = manager.enter(ctx('p1'), 'u1');
    await waitFor(() => manager.status('p1') === 'starting');
    manager.leave('p1', 'u1'); // Tab zu → Grace scharf, obwohl noch „starting"
    freigeben();
    await expect(ersterStart).rejects.toThrow();
    expect(manager.status('p1')).toBe('stopped');

    // Nutzer öffnet erneut: neue, gesunde VM mit lebendem Betrachter.
    await manager.enter(ctx('p1'), 'u2');
    expect(manager.status('p1')).toBe('running');

    // Der Zombie-Timer des gescheiterten Starts darf sie nicht abräumen.
    await Bun.sleep(200);
    expect(manager.status('p1')).toBe('running');
    expect(gestoppt).toEqual([]);
  });
});

/**
 * Die Heilung (Stop→Neustart bei kaputter VM) braucht einen Deckel: Ohne ihn
 * heilt JEDES enter/ensureRunning erneut. Bei dauerhaft „failed" (der Agent hat
 * den Dev-Server kaputtgeschrieben — die VM LEBT, nur monit hat unmonitored)
 * bedeutet das: jede Nachricht des Nutzers löst zuerst einen vollen VM-Zyklus
 * samt zwei Auto-Commits aus, bevor sein „mach es heil"-Prompt überhaupt
 * anläuft. Ein VM-Neustart repariert kaputten Code ohnehin nicht.
 */
describe('Heilung ist gedeckelt (kein Neustart-Sturm)', () => {
  test('dauerhaft „failed": es wird höchstens einmal geheilt, nicht bei jedem enter', async () => {
    const { provider, manager } = setup({ graceMs: 10_000, healCooldownMs: 10_000 });
    await manager.enter(ctx('p1'), 'u1');
    provider.previewStatusVon.set('p1', 'failed');

    for (let i = 0; i < 5; i += 1) {
      await manager.enter(ctx('p1'), 'u1');
    }

    // Genau EINE Heilung: der Ausgangsstart plus ein Heil-Neustart.
    expect(provider.startCalls).toEqual(['p1', 'p1']);
    expect(provider.stopCalls).toEqual(['p1']);
  });

  test('nach Ablauf der Sperrfrist darf erneut geheilt werden', async () => {
    const { provider, manager } = setup({ graceMs: 10_000, healCooldownMs: 30 });
    await manager.enter(ctx('p1'), 'u1');
    provider.previewStatusVon.set('p1', 'failed');

    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(60);
    await manager.enter(ctx('p1'), 'u1');

    expect(provider.startCalls).toEqual(['p1', 'p1', 'p1']);
    expect(provider.stopCalls).toEqual(['p1', 'p1']);
  });
});

/**
 * N5 aus dem Zustandsmaschinen-Audit: die Grace- und Idle-Timer feuerten
 * `void this.stop(...)` OHNE Rejection-Handler — ein scheiterndes stop()
 * (z. B. msb weg) wurde zur Unhandled Rejection, entgegen der eigenen
 * F18-Konvention (forget/touchVm machen es mit .catch richtig).
 */
describe('Timer-Stopps ohne Rejection-Handler (N5)', () => {
  function providerMitKaputtemStop() {
    const provider: SandboxProvider = {
      async start(): Promise<SandboxHandle> {
        return {
          previewHostPort: 1,
          previewStatus: () => 'ready' as const,
          stop: async () => {
            throw new Error('msb stop kaputt');
          },
        };
      },
    };
    return provider;
  }

  async function mitRejectionFaenger(lauf: () => Promise<void>): Promise<unknown[]> {
    const abgefangen: unknown[] = [];
    const faenger = (reason: unknown): void => {
      abgefangen.push(reason);
    };
    process.on('unhandledRejection', faenger);
    try {
      await lauf();
    } finally {
      process.off('unhandledRejection', faenger);
    }
    return abgefangen;
  }

  test('scheiternder Grace-Stopp wird geloggt statt zur Unhandled Rejection', async () => {
    const manager = new SandboxManager({
      provider: providerMitKaputtemStop(),
      graceMs: 20,
      idleMs: 10_000,
      maxSandboxes: 8,
    });
    const abgefangen = await mitRejectionFaenger(async () => {
      await manager.enter(ctx('p1'), 'u1');
      manager.leave('p1', 'u1'); // letzter Betrachter → Grace scharf
      await waitFor(() => manager.status('p1') === 'stopped');
      await Bun.sleep(30); // Zeit, in der die Rejection hochkäme
    });
    expect(abgefangen).toEqual([]);
  });

  test('scheiternder Idle-Stopp wird geloggt statt zur Unhandled Rejection', async () => {
    const manager = new SandboxManager({
      provider: providerMitKaputtemStop(),
      graceMs: 10_000,
      idleMs: 30,
      maxSandboxes: 8,
    });
    const abgefangen = await mitRejectionFaenger(async () => {
      await manager.enter(ctx('p1'), 'u1');
      await waitFor(() => manager.status('p1') === 'stopped');
      await Bun.sleep(30);
    });
    expect(abgefangen).toEqual([]);
  });
});
