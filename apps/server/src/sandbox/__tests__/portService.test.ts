import { describe, expect, test } from 'bun:test';
import { findFreePort } from '../portService';

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
