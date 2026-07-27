import { describe, expect, test } from 'bun:test';
import { createVmTokenRegistry } from '../vmTokens';

describe('VmTokenRegistry (F4, F12)', () => {
  test('jede Sandbox bekommt ein eigenes Token', () => {
    const registry = createVmTokenRegistry();
    const a = registry.mint('macvibes-a');
    const b = registry.mint('macvibes-b');
    expect(a).not.toBe(b);
    expect(registry.lookup(a)).toEqual({ sandbox: 'macvibes-a' });
    expect(registry.lookup(b)).toEqual({ sandbox: 'macvibes-b' });
  });

  test('ein widerrufenes Token gilt nirgends mehr', () => {
    const registry = createVmTokenRegistry();
    const token = registry.mint('macvibes-a');
    registry.revoke('macvibes-a');
    expect(registry.lookup(token)).toBeNull();
  });

  test('neu ausgestellt entwertet das alte Token derselben Sandbox', () => {
    const registry = createVmTokenRegistry();
    const alt = registry.mint('macvibes-a');
    const neu = registry.mint('macvibes-a');
    expect(registry.lookup(alt)).toBeNull();
    expect(registry.lookup(neu)).toEqual({ sandbox: 'macvibes-a' });
  });

  test('Unsinn wird abgelehnt', () => {
    const registry = createVmTokenRegistry();
    registry.mint('macvibes-a');
    expect(registry.lookup(null)).toBeNull();
    expect(registry.lookup(undefined)).toBeNull();
    expect(registry.lookup('')).toBeNull();
    expect(registry.lookup('geraten')).toBeNull();
  });

  test('das Klartext-Token liegt nirgends in der Registry', () => {
    const registry = createVmTokenRegistry();
    const token = registry.mint('macvibes-a');
    expect(JSON.stringify(registry)).not.toContain(token);
  });
});
