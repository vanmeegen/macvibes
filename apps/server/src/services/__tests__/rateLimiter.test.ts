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

/**
 * H4: Der Login-Resolver bildet den Schlüssel aus `args.username` — die
 * Längenprüfung von usernameSchema greift erst IN login(), also nach dem
 * Limiter. Ein unangemeldeter Angreifer bestimmt damit Inhalt und Länge des
 * Map-Schlüssels, und aufgeräumt wurde nur oberhalb von 1000 Einträgen.
 */
describe('Speichergrenzen bei angreiferbestimmten Schlüsseln (H4)', () => {
  test('lange Schlüssel belegen nur konstant viel Speicher', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => 0 });
    const riesig = 'x'.repeat(1_000_000);
    limiter.check(`user:${riesig}`);
    expect(limiter.keyBytes()).toBeLessThan(500);
  });

  test('lange Schlüssel bleiben trotz Verdichtung unterscheidbar', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
    const a = `user:${'a'.repeat(500)}`;
    const b = `user:${'b'.repeat(500)}`;
    expect(limiter.check(a)).toBe(true);
    expect(limiter.check(a)).toBe(false);
    // b darf nicht in denselben Eimer fallen wie a.
    expect(limiter.check(b)).toBe(true);
  });

  test('die Anzahl der Schlüssel ist hart begrenzt', () => {
    let jetzt = 0;
    const limiter = createRateLimiter({ windowMs: 1_000_000, max: 5, now: () => jetzt });
    // Alle im Fenster, keiner läuft ab — ohne harte Grenze wächst die Map endlos.
    for (let i = 0; i < 20_000; i += 1) {
      jetzt += 1;
      limiter.check(`user:nummer-${i}`);
    }
    expect(limiter.keyCount()).toBeLessThanOrEqual(10_000);
  });

  test('das Limit greift für kurze Schlüssel unverändert', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: () => 0 });
    expect(limiter.check('ip:1.2.3.4')).toBe(true);
    expect(limiter.check('ip:1.2.3.4')).toBe(true);
    expect(limiter.check('ip:1.2.3.4')).toBe(false);
  });
});
