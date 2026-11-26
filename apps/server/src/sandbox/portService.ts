import { createServer } from 'node:net';

function listenOn(port: number, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(null));
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => resolve(boundPort));
    });
  });
}

/**
 * Ist der Port frei? Geprüft wird auf allen Adressen UND eigens auf dem
 * Loopback: die Preview einer VM wird an 127.0.0.1 gebunden (H1), und ein
 * Port, den ein anderes Programm nur dort belegt, ist auf 0.0.0.0 weiter
 * bindbar — die Prüfung allein dort hielte ihn für frei.
 */
async function tryListen(port: number): Promise<number | null> {
  const gebunden = await listenOn(port, '0.0.0.0');
  if (gebunden === null) return null;
  return (await listenOn(gebunden, '127.0.0.1')) === gebunden ? gebunden : null;
}

/**
 * Findet einen freien Host-Port — bevorzugt den gewünschten (previewPort
 * aus templates.json), sonst einen vom System zugewiesenen (R7).
 */
export async function findFreePort(preferred: number): Promise<number> {
  const preferredResult = await tryListen(preferred);
  if (preferredResult !== null) return preferredResult;
  const fallback = await tryListen(0);
  if (fallback === null) {
    throw new Error('Kein freier Port gefunden');
  }
  return fallback;
}

/**
 * Vergibt Host-Ports für Preview-Mappings kollisionsfrei — auch bei parallelen
 * Sandbox-Starts. `findFreePort` allein genügt nicht: zwischen der Prüfung und
 * dem echten `msb run -p`-Binding liegen Sekunden, in denen ein zweiter Start
 * denselben (scheinbar freien) Port zugeteilt bekäme. Der Allocator hält die
 * vergebenen Ports reserviert, bis die Sandbox stoppt.
 */
export class PortAllocator {
  private readonly reserved = new Set<number>();
  /** Zuteilungen laufen strikt nacheinander (s. `allocate`). */
  private kette: Promise<unknown> = Promise.resolve();

  /**
   * @param probe Liefert den gebundenen Port, wenn `port` frei ist (bei 0 einen
   *   vom System gewählten), sonst `null`. Test-Naht; Default prüft das OS.
   */
  constructor(private readonly probe: (port: number) => Promise<number | null> = tryListen) {}

  /**
   * Reserviert und liefert einen freien, noch nicht vergebenen Host-Port.
   *
   * Eine Zuteilung nach der anderen: zwischen „ist der Wunsch-Port reserviert?"
   * und dem Reservieren liegt die Probe am Betriebssystem. Liefen zwei
   * Zuteilungen verschränkt, konnten beide die Probe bestehen und denselben
   * Port bekommen.
   */
  allocate(preferred: number): Promise<number> {
    const lauf = this.kette.then(() => this.zuteilen(preferred));
    // Die Kette darf an einem Fehler nicht reißen.
    this.kette = lauf.catch(() => undefined);
    return lauf;
  }

  private async zuteilen(preferred: number): Promise<number> {
    // Wunsch-Port nur nehmen, wenn er weder OS-belegt NOCH schon reserviert ist.
    if (!this.reserved.has(preferred)) {
      const got = await this.probe(preferred);
      if (got === preferred) {
        this.reserved.add(preferred);
        return preferred;
      }
    }
    // Sonst einen OS-vergebenen Port suchen, der nicht schon reserviert ist.
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = await this.probe(0);
      if (candidate === null) break;
      if (!this.reserved.has(candidate)) {
        this.reserved.add(candidate);
        return candidate;
      }
    }
    throw new Error('Kein freier, unreservierter Port gefunden');
  }

  /** Gibt einen zuvor zugeteilten Port frei (beim Stoppen der Sandbox). */
  release(port: number): void {
    this.reserved.delete(port);
  }
}
