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

  test('ein zweites Signal während eines hängenden Abgangs beendet sofort', async () => {
    const codes: number[] = [];
    const sequenz = new ShutdownSequence({
      exit: (code) => void codes.push(code),
      log: () => {},
      stepTimeoutMs: 10_000, // lang, damit der erste Lauf beim Test noch hängt
    });
    sequenz.register('haengt', () => new Promise<void>(() => {}));

    // Erstes Signal: startet den (hängenden) Abgang, wartet NICHT darauf.
    void sequenz.handle('SIGINT');
    await Bun.sleep(10);
    // Zweites Ctrl-C: der Nutzer will jetzt raus.
    await sequenz.handle('SIGINT');

    // Sofortiges Beenden mit einem Code != 0 (der Abgang war nicht sauber).
    expect(codes).toContain(1);
  });
});
