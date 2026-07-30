import { describe, expect, test } from 'bun:test';
import { revalidateStream } from '../revalidateStream';

async function* quelle(werte: number[], verzoegerungMs = 0): AsyncGenerator<number> {
  for (const w of werte) {
    if (verzoegerungMs > 0) await Bun.sleep(verzoegerungMs);
    yield w;
  }
}

async function sammeln<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

/**
 * H6: `requireUser` läuft bei einer Subscription genau einmal — beim Aufbau des
 * Iterators. Danach prüfte nichts mehr, also empfing ein Nutzer weiter
 * Live-Agent-Output, nachdem seine Session gelöscht wurde (Logout, Ablauf,
 * Admin-rejectUser).
 */
describe('revalidateStream (H6)', () => {
  test('reicht alle Werte durch, solange die Session gilt', async () => {
    const werte = await sammeln(
      revalidateStream(
        quelle([1, 2, 3]),
        async () => true,
        0,
        () => 0,
      ),
    );
    expect(werte).toEqual([1, 2, 3]);
  });

  test('bricht ab, sobald die Session weg ist', async () => {
    let gueltig = true;
    let jetzt = 0;
    const strom = revalidateStream(
      quelle([1, 2, 3, 4]),
      async () => gueltig,
      10,
      () => {
        jetzt += 20; // jedes Event liegt hinter dem Prüfintervall
        return jetzt;
      },
    );
    const out: number[] = [];
    for await (const v of strom) {
      out.push(v);
      if (out.length === 2) gueltig = false;
    }
    expect(out).toEqual([1, 2]);
  });

  test('prüft nicht bei jedem Event, sondern höchstens im Intervall', async () => {
    let pruefungen = 0;
    let jetzt = 0;
    await sammeln(
      revalidateStream(
        quelle([1, 2, 3, 4, 5]),
        async () => {
          pruefungen += 1;
          return true;
        },
        1000,
        () => {
          jetzt += 1; // Zeit läuft kaum — das Intervall ist nie erreicht
          return jetzt;
        },
      ),
    );
    // Eine Prüfung beim Aufbau, danach keine weitere innerhalb des Intervalls.
    expect(pruefungen).toBe(1);
  });

  test('prüft vor dem ersten Wert, nicht erst danach', async () => {
    const out = await sammeln(
      revalidateStream(
        quelle([1, 2]),
        async () => false,
        1000,
        () => 0,
      ),
    );
    expect(out).toEqual([]);
  });

  test('schließt die Quelle beim Abbruch (kein verwaister Generator)', async () => {
    let geschlossen = false;
    async function* beobachtet(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
        yield 3;
      } finally {
        geschlossen = true;
      }
    }
    let gueltig = true;
    let jetzt = 0;
    const strom = revalidateStream(
      beobachtet(),
      async () => gueltig,
      10,
      () => {
        jetzt += 20;
        return jetzt;
      },
    );
    for await (const v of strom) {
      if (v === 1) gueltig = false;
    }
    expect(geschlossen).toBe(true);
  });
});
