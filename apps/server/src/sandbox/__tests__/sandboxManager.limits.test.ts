import { describe, expect, test } from 'bun:test';
import type { SandboxHandle, SandboxProvider } from '../provider';
import { SandboxManager } from '../sandboxManager';
import { waitFor } from '../../testing/testUtils';
import { ctx, FakeProvider, setup, torProvider } from './sandboxManagerFixtures';

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
        return true;
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
      touchSandbox: async (): Promise<boolean> => {
        throw new Error('msb antwortet nicht');
      },
    });
    await manager.enter(ctx('p1'), 'u1');
    await Bun.sleep(20);
    manager.noteAgentActivity('p1');
    await Bun.sleep(20);
    expect(manager.status('p1')).toBe('running');
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
 * N8 aus dem Zustandsmaschinen-Audit: kam zwischen stop() und forget() ein
 * enter() dazwischen, machte forget nur einen Nachhol-Stopp und liess den
 * Map-Eintrag FÜR IMMER stehen — ein kleines Leck pro Lösch-Race. Rennen-Test
 * #9 pinnt, dass der Eintrag WÄHREND des Stopps erhalten bleibt (keine
 * verwaiste VM); hier kommt die zweite Hälfte: NACH dem vollendeten
 * Nachhol-Stopp verschwindet er.
 */
describe('forget() räumt den Eintrag nach dem Nachhol-Stopp ab (N8)', () => {
  test('auch wenn der Nachhol-Stopp WIRFT, verschwindet der Eintrag (kein Dauer-Leck)', async () => {
    // stop() setzt `stopped` im finally — auch bei einem werfenden
    // handle.stop(). Hinge die Löschung nur am Erfolgspfad, bliebe der
    // Buchhaltungseintrag eines GELÖSCHTEN Projekts für die Prozesslaufzeit
    // stehen: genau das Leck, das forget beseitigen soll.
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
    const manager = new SandboxManager({
      provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
    });
    await manager.enter(ctx('p1'), 'u1');

    // forget auf laufender Sandbox → Nachhol-Stopp (der wirft).
    manager.forget('p1');
    await waitFor(() => manager.trackedProjects() === 0);
  });

  test('der Nachhol-Stopp löscht den Eintrag, sobald er vollendet ist', async () => {
    const t = torProvider();
    const manager = new SandboxManager({
      provider: t.provider,
      graceMs: 10_000,
      idleMs: 10_000,
      maxSandboxes: 8,
    });

    // Exakt das #9-Szenario: stop(), enter() dazwischen, forget() mitten im Start.
    const start1 = manager.enter(ctx('p1'), 'u1');
    await t.warteAufTor('p1');
    t.freigeben('p1');
    await start1;
    await manager.stop('p1');
    const neuerStart = manager.enter(ctx('p1'), 'u2');
    await t.warteAufTor('p1');

    manager.forget('p1');

    t.freigeben('p1');
    await neuerStart;

    // #9 hält hier fest: nicht sofort verwaist. Aber der Nachhol-Stopp muss
    // den Eintrag danach abräumen — sonst bleibt er für die Prozesslaufzeit.
    await waitFor(() => manager.trackedProjects() === 0);
    expect(manager.status('p1')).toBe('stopped');
    expect(t.gestoppt).toContain('p1');
  });
});
