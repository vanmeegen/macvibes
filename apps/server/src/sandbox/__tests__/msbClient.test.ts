import { describe, expect, test } from 'bun:test';
import { SandboxNotFoundError } from 'microsandbox';
import {
  istSandboxNichtGefunden,
  istSnapshotNichtGefunden,
  msbAvailable,
  removeSandbox,
  snapshotExists,
  stopSandbox,
  waitForSandboxReady,
} from '../msbClient';

const available = await msbAvailable();

/**
 * Die Fehlerklassifikation ist der Kern des Umstiegs auf das SDK: vorher wurde
 * JEDER msb-Fehler als „existiert nicht" gedeutet (runMsb warf für alles
 * denselben MicrosandboxError). War msb kaputt, meldete macvibes deshalb
 * „Keine Baseline — bitte bun run baselines" statt des echten Fehlers.
 */
describe('Fehlerklassifikation', () => {
  test('erkennt eine fehlende Sandbox am typisierten Fehler', () => {
    expect(istSandboxNichtGefunden(new SandboxNotFoundError('sandbox not found: x'))).toBe(true);
  });

  test('deutet andere Fehler NICHT als „fehlt"', () => {
    // Genau der Fall, der die Baseline-Meldung vorher verfälscht hat.
    const schema = new Error('runtime error: database schema is newer than this msb binary');
    expect(istSandboxNichtGefunden(schema)).toBe(false);
    expect(istSnapshotNichtGefunden(schema)).toBe(false);
    expect(istSandboxNichtGefunden(new Error('permission denied'))).toBe(false);
    expect(istSnapshotNichtGefunden(new Error('permission denied'))).toBe(false);
  });

  test('erkennt einen fehlenden Snapshot an der Kennung im Text', () => {
    // Das SDK typisiert Snapshot-Fehler (noch) nicht: Snapshot.get wirft ein
    // generiches Error mit code=GenericFailure und der Kennung im Text.
    // Empirisch geprüft gegen microsandbox 0.6.8.
    expect(
      istSnapshotNichtGefunden(new Error('[SnapshotNotFound] snapshot not found: gibtsnicht')),
    ).toBe(true);
  });

  test('verträgt Nicht-Fehler ohne zu werfen', () => {
    for (const wert of [null, undefined, 'text', 42, {}]) {
      expect(istSandboxNichtGefunden(wert)).toBe(false);
      expect(istSnapshotNichtGefunden(wert)).toBe(false);
    }
  });
});

describe.skipIf(!available)('snapshotExists (gegen die echte Laufzeit)', () => {
  test('findet einen vorhandenen Snapshot', async () => {
    expect(await snapshotExists('macvibes-tpl-msbtest-v2')).toBe(true);
  });

  test('meldet einen fehlenden Snapshot als false', async () => {
    expect(await snapshotExists('macvibes-gibt-es-nicht-xyz')).toBe(false);
  });
});

describe.skipIf(!available)('Stoppen und Entfernen (gegen die echte Laufzeit)', () => {
  test('stopSandbox einer unbekannten Sandbox ist folgenlos', async () => {
    // Idempotenz: der Aufräumpfad läuft auch, wenn schon jemand aufgeräumt hat.
    await expect(stopSandbox('macvibes-gibt-es-nicht-xyz')).resolves.toBeUndefined();
  });

  test('removeSandbox einer unbekannten Sandbox ist folgenlos', async () => {
    await expect(removeSandbox('macvibes-gibt-es-nicht-xyz')).resolves.toBeUndefined();
  });
});

describe('waitForSandboxReady', () => {
  test('kehrt zurück, sobald die Probe gelingt', async () => {
    let versuche = 0;
    await waitForSandboxReady('egal', {
      timeoutMs: 1000,
      intervalMs: 5,
      probe: async () => {
        versuche += 1;
        if (versuche < 3) throw new Error('noch nicht bereit');
      },
    });
    expect(versuche).toBe(3);
  });

  test('meldet nach der Frist einen Fehler, der die letzte Ursache nennt', async () => {
    // Vorher stand hier nur „wurde nicht exec-bereit" plus String(error) —
    // die eigentliche Ursache ging im Text unter.
    const versuch = waitForSandboxReady('kaputt', {
      timeoutMs: 30,
      intervalMs: 5,
      probe: async () => {
        throw new Error('agent nicht erreichbar');
      },
    });
    await expect(versuch).rejects.toThrow(/kaputt/);
    await expect(versuch).rejects.toThrow(/agent nicht erreichbar/);
  });
});
