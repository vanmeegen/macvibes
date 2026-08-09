import { describe, expect, test } from 'bun:test';
import { ShutdownSequence } from '../shutdownSequence';

/**
 * Der Fehler, den diese Tests festhalten: In `index.ts` lagen zwei getrennte
 * SIGINT/SIGTERM-Handler. Der früher registrierte stoppte den lokalen
 * Modell-Router und rief `process.exit(0)`; der spätere stoppte die Sandboxes
 * MIT Auto-Commit. Weil `router.stop()` im Normalfall ein sofort aufgelöstes
 * No-op ist, beendete der erste Handler den Prozess, bevor der zweite den
 * Commit schreiben konnte — bei jedem Herunterfahren mit laufender VM ging der
 * letzte Turn verloren.
 *
 * Die entscheidende Zusicherung ist deshalb: Der Prozess wird ERST beendet,
 * wenn jeder registrierte Schritt fertig ist.
 */

/** Sammelt den zeitlichen Ablauf, damit die Reihenfolge prüfbar ist. */
function protokoll(): { eintraege: string[]; notiere: (was: string) => void } {
  const eintraege: string[] = [];
  return { eintraege, notiere: (was: string) => void eintraege.push(was) };
}

describe('ShutdownSequence: Auto-Commit darf nicht abgeschnitten werden', () => {
  test('beendet den Prozess erst, wenn ein langsamer Schritt fertig ist', async () => {
    const { eintraege, notiere } = protokoll();
    const sequenz = new ShutdownSequence({
      exit: () => notiere('exit'),
      log: () => {},
    });

    // Genau die Konstellation aus index.ts: ein sofort fertiger Schritt
    // (Router-Stopp) und ein langsamer (Sandboxes stoppen + Auto-Commit).
    sequenz.register('lokaler Modell-Router', async () => {
      notiere('router');
    });
    sequenz.register('Sandboxes', async () => {
      await Bun.sleep(30);
      notiere('auto-commit');
    });

    await sequenz.handle('SIGTERM');

    // Der Auto-Commit MUSS vor dem Prozessende stehen.
    expect(eintraege).toEqual(['auto-commit', 'router', 'exit']);
  });

  test('stoppt in umgekehrter Registrierungsreihenfolge', async () => {
    const { eintraege, notiere } = protokoll();
    const sequenz = new ShutdownSequence({ exit: () => {}, log: () => {} });

    sequenz.register('zuerst gestartet', () => notiere('a'));
    sequenz.register('dann', () => notiere('b'));
    sequenz.register('zuletzt gestartet', () => notiere('c'));

    await sequenz.handle('SIGINT');

    expect(eintraege).toEqual(['c', 'b', 'a']);
  });

  test('ein fehlgeschlagener Schritt verhindert die übrigen nicht', async () => {
    const { eintraege, notiere } = protokoll();
    const gemeldet: string[] = [];
    const sequenz = new ShutdownSequence({
      exit: () => notiere('exit'),
      log: (nachricht) => void gemeldet.push(nachricht),
    });

    sequenz.register('Sandboxes', () => notiere('sandboxes'));
    sequenz.register('kaputt', () => {
      throw new Error('msb antwortet nicht');
    });

    await sequenz.handle('SIGTERM');

    // Der Auto-Commit läuft trotz des Fehlers davor, und der Prozess endet.
    expect(eintraege).toEqual(['sandboxes', 'exit']);
    // Konvention: keine verschluckten Exceptions — der Fehler wird gemeldet.
    expect(gemeldet.join('\n')).toContain('kaputt');
    expect(gemeldet.join('\n')).toContain('msb antwortet nicht');
  });

  test('ein zweites Signal führt die Schritte nicht erneut aus', async () => {
    // Die Schritte laufen genau EINMAL — auch wenn zweimal Ctrl-C kommt.
    // (Dass das zweite Signal zusätzlich einen sofortigen Notausstieg auslöst,
    // prüft der Timeout-Block weiter unten; im echten process.exit gewinnt der
    // erste exit-Aufruf ohnehin.)
    let laeufe = 0;
    const codes: number[] = [];
    const sequenz = new ShutdownSequence({ exit: (code) => void codes.push(code), log: () => {} });
    sequenz.register('Sandboxes', async () => {
      laeufe += 1;
      await Bun.sleep(10);
    });

    // Ctrl-C zweimal gedrückt, während der Stopp schon läuft.
    await Promise.all([sequenz.handle('SIGINT'), sequenz.handle('SIGINT')]);

    expect(laeufe).toBe(1);
  });

  test('ohne registrierte Schritte wird trotzdem beendet', async () => {
    let exits = 0;
    const sequenz = new ShutdownSequence({ exit: () => void (exits += 1), log: () => {} });

    await sequenz.handle('SIGTERM');

    expect(exits).toBe(1);
  });
});

/**
 * Der zweite Review fand: die Sequenz hatte KEINEN Timeout pro Schritt. Hängt
 * ein Schritt (stopAll() wartet auf ein startPromise, git auf eine index.lock,
 * msb stop kehrt nicht zurück), wird exit() nie erreicht und der Prozess ist
 * nur per SIGKILL beendbar — wodurch genau der Auto-Commit verloren geht, den
 * die Sequenz retten sollte.
 */
describe('ShutdownSequence: hängender Schritt macht den Prozess nicht unbeendbar', () => {
  test('überspringt einen hängenden Schritt nach der Frist und beendet trotzdem', async () => {
    const { eintraege, notiere } = protokoll();
    const sequenz = new ShutdownSequence({
      exit: () => notiere('exit'),
      log: () => {},
      stepTimeoutMs: 30,
    });

    sequenz.register('Sandboxes', () => notiere('sandboxes'));
    sequenz.register('haengt', () => new Promise<void>(() => {})); // nie erfüllt

    await sequenz.handle('SIGTERM');

    // Rückwärts: der hängende Schritt zuerst (wird nach 30ms übersprungen),
    // dann der Sandboxes-Schritt, dann exit.
    expect(eintraege).toEqual(['sandboxes', 'exit']);
  });

  test('respektiert eine per-Schritt konfigurierte Frist statt der Default-Frist', async () => {
    // Kern der Fristen-Lösung (Live-Befund 2026-08): Schritte bekommen einzeln
    // eine Frist. Ein knapp befristeter Schritt wird übersprungen, während ein
    // großzügig befristeter (der Auto-Commit) fertig laufen darf — auch wenn er
    // länger braucht als die knappe Frist des anderen.
    const { eintraege, notiere } = protokoll();
    const sequenz = new ShutdownSequence({
      exit: () => notiere('exit'),
      log: () => {},
      // Default absichtlich winzig: würde er (statt der per-Schritt-Frist)
      // greifen, würde der Auto-Commit fälschlich übersprungen.
      stepTimeoutMs: 5,
    });

    // Zuletzt registriert = zuerst gestoppt.
    sequenz.register(
      'Auto-Commit',
      async () => {
        await Bun.sleep(40);
        notiere('auto-commit');
      },
      1_000, // großzügige eigene Frist
    );
    sequenz.register('haengt', () => new Promise<void>(() => {}), 20); // knappe eigene Frist

    await sequenz.handle('SIGTERM');

    // Der hängende Schritt wird nach seiner 20-ms-Frist übersprungen; der
    // Auto-Commit läuft trotz der 5-ms-Default-Frist bis zu seinen 40 ms durch.
    expect(eintraege).toEqual(['auto-commit', 'exit']);
  });

  test('ein zweites Signal schneidet einen laufenden Schritt NICHT ab', async () => {
    // Ein zweiter Ctrl-C darf keinen Notausstieg auslösen: er würde einen gerade
    // laufenden Auto-Commit (Release, während jemand in der Sandbox arbeitet)
    // mitten abschneiden. Das zweite Signal wartet den laufenden Abgang ab;
    // gegen echte Hänger schützt die Frist pro Schritt.
    const codes: number[] = [];
    let schrittFertig = false;
    let freigeben: () => void = () => {};
    const sequenz = new ShutdownSequence({
      exit: (code) => void codes.push(code),
      log: () => {},
      stepTimeoutMs: 10_000,
    });
    sequenz.register('Auto-Commit', async () => {
      await new Promise<void>((r) => {
        freigeben = r;
      });
      schrittFertig = true;
    });

    void sequenz.handle('SIGINT');
    await Bun.sleep(10);
    void sequenz.handle('SIGINT'); // zweites Ctrl-C, während der Schritt läuft

    // Kein sofortiges exit, solange der Schritt läuft.
    await Bun.sleep(10);
    expect(codes).toEqual([]);
    expect(schrittFertig).toBe(false);

    // Erst wenn der Schritt (Auto-Commit) fertig ist, endet der Prozess — genau einmal.
    freigeben();
    await Bun.sleep(10);
    expect(schrittFertig).toBe(true);
    expect(codes).toEqual([0]);
  });
});
