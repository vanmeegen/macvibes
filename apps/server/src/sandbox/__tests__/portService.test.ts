import { describe, expect, test } from 'bun:test';
import { findFreePort, PortAllocator } from '../portService';

describe('findFreePort', () => {
  test('bevorzugt den gewünschten Port, wenn er frei ist', async () => {
    const port = await findFreePort(45871);
    expect(port).toBe(45871);
  });

  test('weicht auf einen anderen freien Port aus, wenn belegt', async () => {
    const blocker = Bun.serve({ port: 45872, fetch: () => new Response('belegt') });
    try {
      const port = await findFreePort(45872);
      expect(port).toBeGreaterThan(0);
      expect(port).not.toBe(45872);
    } finally {
      blocker.stop(true);
    }
  });
});

describe('PortAllocator — keine Kollision bei parallelen Sandbox-Starts', () => {
  test('reserviert Ports: zwei Zuteilungen mit gleichem Wunsch-Port kollidieren nicht', async () => {
    const alloc = new PortAllocator();
    const a = await alloc.allocate(45880);
    // Zweite Zuteilung, BEVOR a tatsächlich gebunden ist (echter Race) — muss abweichen.
    const b = await alloc.allocate(45880);
    expect(a).toBe(45880);
    expect(b).not.toBe(a);
    alloc.release(a);
    alloc.release(b);
  });

  test('drei parallele Zuteilungen liefern drei verschiedene Ports', async () => {
    const alloc = new PortAllocator();
    const ports = await Promise.all([
      alloc.allocate(45881),
      alloc.allocate(45881),
      alloc.allocate(45881),
    ]);
    expect(new Set(ports).size).toBe(3);
    ports.forEach((p) => alloc.release(p));
  });

  test('nach release ist der Wunsch-Port wieder vergebbar', async () => {
    const alloc = new PortAllocator();
    const a = await alloc.allocate(45882);
    expect(a).toBe(45882);
    alloc.release(a);
    const b = await alloc.allocate(45882);
    expect(b).toBe(45882);
    alloc.release(b);
  });
});
