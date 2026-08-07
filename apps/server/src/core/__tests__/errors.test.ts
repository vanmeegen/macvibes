import { describe, expect, test } from 'bun:test';
import { GraphQLError } from 'graphql';
import { DomainError } from '../errors';
import { SandboxCapacityError } from '../../sandbox/sandboxManager';

/**
 * M3: DomainError ist ein reiner Error-Abkömmling. Die frühere Vererbung von
 * GraphQLError hängte das `graphql`-Paket an jeden Wurf in core/services/
 * sandbox — die Basisschicht kannte damit die Präsentationstechnik. Ob eine
 * Message Yogas Maskierung (F24) übersteht, entscheidet seitdem die
 * http-Schicht per `instanceof DomainError` (createAppYoga, maskError-Hook).
 */
describe('DomainError (core, ohne Präsentationstechnik)', () => {
  test('erbt NICHT mehr von GraphQLError — core kennt kein GraphQL', () => {
    expect(new DomainError('kaputt') instanceof GraphQLError).toBe(false);
    expect(Object.getPrototypeOf(DomainError)).toBe(Error);
  });

  test('bleibt ein echter Error mit Name und Message', () => {
    const error = new DomainError('Projekt nicht gefunden');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof DomainError).toBe(true);
    expect(error.name).toBe('DomainError');
    expect(error.message).toBe('Projekt nicht gefunden');
  });

  test('Subklassen wie SandboxCapacityError bleiben instanceof-kompatibel', () => {
    const error = new SandboxCapacityError('Alle Plätze belegt');
    expect(error instanceof SandboxCapacityError).toBe(true);
    expect(error instanceof DomainError).toBe(true);
    expect(error instanceof Error).toBe(true);
    expect(error.name).toBe('SandboxCapacityError');
    expect(error.message).toBe('Alle Plätze belegt');
  });
});
