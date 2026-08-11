import { describe, expect, test } from 'bun:test';
import type { VmTokenRegistry } from '../core/vmTokens';
import { initHotReload } from '../devHotReload';

// Marker-Objekt genügt: die Übergabe reicht Referenzen durch, ohne sie zu nutzen.
const fakeTokens = { marker: 'tokens' } as unknown as VmTokenRegistry;

const HOT = ['--hot'] as const;

describe('initHotReload ohne --hot (Produktion)', () => {
  test('hinterlässt keinerlei Zustand am Scope und erbt nichts', async () => {
    const scope = {};
    const hot = await initHotReload({ scope, execArgv: [] });
    hot.addCleanup('etwas', () => {});
    hot.handOver.vmTokens = fakeTokens;

    // Kein Register am Scope — Produktion bleibt zustandsfrei.
    expect(Object.getOwnPropertySymbols(scope)).toHaveLength(0);

    // Ein zweiter Start (gäbe es ihn) erbt entsprechend nichts.
    const hot2 = await initHotReload({ scope, execArgv: [] });
    expect(hot2.inherited.vmTokens).toBeNull();
    expect(hot2.inherited.localRouter).toBeNull();
  });
});

describe('initHotReload mit --hot', () => {
  test('die nächste Ausführung räumt in umgekehrter Reihenfolge ab und erbt die Übergabe', async () => {
    const scope = {};
    const order: string[] = [];
    const hot1 = await initHotReload({ scope, execArgv: HOT, log: () => {} });
    hot1.addCleanup('zuerst gebunden', () => {
      order.push('zuerst gebunden');
    });
    hot1.addCleanup('zuletzt gebunden', async () => {
      order.push('zuletzt gebunden');
    });
    hot1.handOver.vmTokens = fakeTokens;

    const hot2 = await initHotReload({ scope, execArgv: HOT, log: () => {} });
    // Zuletzt Gebundenes zuerst geschlossen (wie die ShutdownSequence).
    expect(order).toEqual(['zuletzt gebunden', 'zuerst gebunden']);
    expect(hot2.inherited.vmTokens).toBe(fakeTokens);
    expect(hot2.inherited.localRouter).toBeNull();
  });

  test('Schritte werden erst beim NÄCHSTEN Start ausgeführt, nicht beim eigenen', async () => {
    const scope = {};
    let called = 0;
    const hot = await initHotReload({ scope, execArgv: HOT, log: () => {} });
    hot.addCleanup('x', () => {
      called += 1;
    });
    expect(called).toBe(0);
    await initHotReload({ scope, execArgv: HOT, log: () => {} });
    expect(called).toBe(1);
  });

  test('ein werfender Schritt verhindert die folgenden nicht und wird gemeldet', async () => {
    const scope = {};
    const messages: string[] = [];
    const order: string[] = [];
    const hot1 = await initHotReload({ scope, execArgv: HOT, log: () => {} });
    hot1.addCleanup('läuft trotzdem', () => {
      order.push('läuft trotzdem');
    });
    hot1.addCleanup('wirft', () => {
      throw new Error('kaputt');
    });

    await initHotReload({ scope, execArgv: HOT, log: (m) => messages.push(m) });
    expect(order).toEqual(['läuft trotzdem']);
    expect(messages.join('\n')).toContain('wirft');
    expect(messages.join('\n')).toContain('kaputt');
  });

  test('ein hängender Schritt wird nach der Frist übersprungen', async () => {
    const scope = {};
    const messages: string[] = [];
    const order: string[] = [];
    const hot1 = await initHotReload({ scope, execArgv: HOT, log: () => {} });
    hot1.addCleanup('läuft trotzdem', () => {
      order.push('läuft trotzdem');
    });
    hot1.addCleanup('hängt', () => new Promise<void>(() => {}));

    await initHotReload({
      scope,
      execArgv: HOT,
      log: (m) => messages.push(m),
      stepTimeoutMs: 20,
    });
    expect(order).toEqual(['läuft trotzdem']);
    expect(messages.join('\n')).toContain('hängt');
  });

  test('das Register wird beim Abräumen geleert — ein Erben aus der Vor-Vor-Ausführung gibt es nicht', async () => {
    const scope = {};
    const hot1 = await initHotReload({ scope, execArgv: HOT, log: () => {} });
    hot1.handOver.vmTokens = fakeTokens;
    // Zweite Ausführung erbt, gibt aber selbst nichts weiter.
    const hot2 = await initHotReload({ scope, execArgv: HOT, log: () => {} });
    expect(hot2.inherited.vmTokens).toBe(fakeTokens);
    // Dritte Ausführung erbt entsprechend nichts mehr.
    const hot3 = await initHotReload({ scope, execArgv: HOT, log: () => {} });
    expect(hot3.inherited.vmTokens).toBeNull();
  });
});
