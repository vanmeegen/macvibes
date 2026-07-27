import { describe, expect, test } from 'bun:test';
import { createRateLimiter } from '../rateLimiter';

describe('createRateLimiter (F14)', () => {
  test('lässt bis zum Limit durch und bremst danach', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: () => 0 });
    expect([limiter.check('a'), limiter.check('a'), limiter.check('a')]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.check('a')).toBe(false);
  });

  test('zählt pro Schlüssel getrennt', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
    expect(limiter.check('ip:1')).toBe(true);
    expect(limiter.check('ip:2')).toBe(true);
    expect(limiter.check('ip:1')).toBe(false);
  });

  test('nach Ablauf des Fensters ist wieder frei', () => {
    let jetzt = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => jetzt });
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
    jetzt = 1001;
    expect(limiter.check('a')).toBe(true);
  });

  test('abgewiesene Versuche verlängern die Sperre nicht', () => {
    let jetzt = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => jetzt });
    limiter.check('a');
    // Dauerfeuer während der Sperre …
    for (let i = 0; i < 50; i += 1) {
      jetzt += 10;
      expect(limiter.check('a')).toBe(false);
    }
    // … das Fenster läuft trotzdem ab dem ERSTEN Versuch ab.
    jetzt = 1001;
    expect(limiter.check('a')).toBe(true);
  });
});
