import { describe, expect, test } from 'bun:test';
import { releaseOnClose } from '../releaseOnClose';

/**
 * H11: Der Betrachter-Refcount haengt an der Lebensdauer der
 * chatEvents-Subscription. `releaseOnClose` ist das Stueck, das das
 * "Betrachter ist gegangen"-Signal GARANTIERT liefert — egal ob die Quelle
 * normal endet, wirft, oder der Konsument (Yoga bei Client-Disconnect) den
 * Iterator per `.return()` abbricht.
 */

async function* quelle(werte: number[]): AsyncGenerator<number> {
  for (const wert of werte) {
    yield wert;
  }
}

describe('releaseOnClose', () => {
  test('reicht die Werte der Quelle unveraendert durch und gibt am Ende frei', async () => {
    let freigaben = 0;
    const stream = releaseOnClose(quelle([1, 2, 3]), () => {
      freigaben += 1;
    });
    const gesehen: number[] = [];
    for await (const wert of stream) {
      gesehen.push(wert);
    }
    expect(gesehen).toEqual([1, 2, 3]);
    expect(freigaben).toBe(1);
  });

  test('gibt bei .return() frei — auch wenn NIE ein Wert konsumiert wurde', async () => {
    // Der kritische Fall: die Verbindung reisst ab, BEVOR das erste Event kam.
    // Ein async-Generator mit try/finally liefe hier NICHT durch sein finally
    // (nie mit next() angestossen) — der Betrachter bliebe fuer immer gezaehlt.
    let freigaben = 0;
    const stream = releaseOnClose(quelle([1, 2, 3]), () => {
      freigaben += 1;
    });
    await stream.return?.(undefined);
    expect(freigaben).toBe(1);
  });

  test('schliesst bei .return() auch die Quelle', async () => {
    let quelleGeschlossen = false;
    const source: AsyncIterableIterator<number> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => ({ value: 1, done: false }),
      return: async () => {
        quelleGeschlossen = true;
        return { value: undefined, done: true };
      },
    };
    const stream = releaseOnClose(source, () => {});
    await stream.return?.(undefined);
    expect(quelleGeschlossen).toBe(true);
  });

  test('gibt frei, wenn die Quelle wirft', async () => {
    let freigaben = 0;
    // eslint-disable-next-line require-yield
    async function* kaputt(): AsyncGenerator<number> {
      throw new Error('Quelle kaputt');
    }
    const stream = releaseOnClose(kaputt(), () => {
      freigaben += 1;
    });
    await expect(stream.next()).rejects.toThrow('Quelle kaputt');
    expect(freigaben).toBe(1);
  });

  test('gibt genau EINMAL frei, auch bei mehrfachem Schliessen', async () => {
    let freigaben = 0;
    const stream = releaseOnClose(quelle([1]), () => {
      freigaben += 1;
    });
    await stream.next();
    await stream.next(); // done → Freigabe
    await stream.return?.(undefined);
    await stream.return?.(undefined);
    expect(freigaben).toBe(1);
  });
});

/**
 * Quelle, die wie `revalidateStream` im Normalbetrieb in einem await haengt:
 * next() loest nie auf (kein Chat-Event in Sicht), und return()/throw() loesen
 * ebenfalls nie auf — per Spec wird das return() eines in einem await
 * suspendierten async-Generators hinter den laufenden Request eingereiht und
 * erst beim naechsten Erreichen eines yield verarbeitet. Bei einem ruhigen
 * Projekt (kein Turn, keine Events) heisst das: NIE.
 */
function haengendeQuelle(): AsyncIterableIterator<number> & { returnAufrufe: number } {
  const source = {
    returnAufrufe: 0,
    [Symbol.asyncIterator]() {
      return source;
    },
    next: () => new Promise<IteratorResult<number>>(() => {}),
    return: () => {
      source.returnAufrufe += 1;
      return new Promise<IteratorResult<number>>(() => {});
    },
    throw: () => new Promise<IteratorResult<number>>(() => {}),
  };
  return source;
}

describe('releaseOnClose bei einer im await suspendierten Quelle (Defekt 1)', () => {
  test('gibt bei .return() SOFORT frei, obwohl die Quelle haengt (Tab zu bei ruhigem Projekt)', async () => {
    let freigaben = 0;
    const source = haengendeQuelle();
    const stream = releaseOnClose(source, () => {
      freigaben += 1;
    });
    // Yoga hat immer ein next() in Flight — genau diese Suspension nachstellen.
    const laufendesNext = stream.next();
    const rueckgabe = stream.return?.(undefined);

    // Die Freigabe (sandboxManager.leave) darf NICHT auf inner.return() warten:
    // sie muss beim Aufruf von return() bereits gefeuert sein.
    expect(freigaben).toBe(1);
    // Die Quelle wird trotzdem geschlossen (Aufruf angestossen, nicht abgewartet).
    expect(source.returnAufrufe).toBe(1);
    // Der Konsument bekommt sein done, ohne auf die haengende Quelle zu warten.
    const ergebnis = await Promise.race([rueckgabe, Bun.sleep(50).then(() => 'haengt' as const)]);
    expect(ergebnis).toEqual({ value: undefined, done: true });
    laufendesNext.catch(() => {}); // haengt absichtlich weiter
  });

  test('mehrfaches return() bei haengender Quelle gibt weiterhin genau EINMAL frei', () => {
    let freigaben = 0;
    const stream = releaseOnClose(haengendeQuelle(), () => {
      freigaben += 1;
    });
    void stream.return?.(undefined)?.catch(() => {});
    void stream.return?.(undefined)?.catch(() => {});
    expect(freigaben).toBe(1);
  });

  test('.throw() gibt frei, ohne auf die haengende Quelle zu warten', () => {
    let freigaben = 0;
    const stream = releaseOnClose(haengendeQuelle(), () => {
      freigaben += 1;
    });
    void stream.throw?.(new Error('Client weg'))?.catch(() => {});
    expect(freigaben).toBe(1);
  });

  test('ein Fehler beim Schliessen der Quelle blockiert die Freigabe nicht', async () => {
    let freigaben = 0;
    const source: AsyncIterableIterator<number> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => ({ value: 1, done: false }),
      return: async () => {
        throw new Error('Quelle kaputt beim Schliessen');
      },
    };
    const stream = releaseOnClose(source, () => {
      freigaben += 1;
    });
    // return() darf weder haengen noch die Rejection der Quelle durchreichen —
    // die Freigabe ist zu diesem Zeitpunkt schon erledigt.
    await stream.return?.(undefined);
    expect(freigaben).toBe(1);
    // Der floating inner.return() braucht einen .catch — eine Unhandled
    // Rejection liesse den Testlauf (und in Produktion den Prozess) scheitern.
    await Bun.sleep(10);
  });
});
