import { createServer } from 'node:net';

function tryListen(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(null));
    server.listen(port, '0.0.0.0', () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => resolve(boundPort));
    });
  });
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

  /** Reserviert und liefert einen freien, noch nicht vergebenen Host-Port. */
  async allocate(preferred: number): Promise<number> {
    // Wunsch-Port nur nehmen, wenn er weder OS-belegt NOCH schon reserviert ist.
    if (!this.reserved.has(preferred)) {
      const got = await tryListen(preferred);
      if (got === preferred) {
        this.reserved.add(preferred);
        return preferred;
      }
    }
    // Sonst einen OS-vergebenen Port suchen, der nicht schon reserviert ist.
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = await tryListen(0);
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
