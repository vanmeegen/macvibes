import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomId } from '../randomId';

/**
 * Der Fehler, den diese Tests festhalten: crypto.randomUUID() im
 * Feld-Initialisierer des ProjectsStore riss die GANZE Web-App über
 * LAN-http herunter (kein Secure Context, crypto.randomUUID undefined,
 * TypeError beim Bootstrap, React mountet nie). randomId() muss dort weiter
 * eine ID liefern.
 */
describe('randomId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('nutzt crypto.randomUUID im Secure Context', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-aus-crypto' });
    expect(randomId()).toBe('uuid-aus-crypto');
  });

  it('liefert ohne Secure Context trotzdem eine ID, statt zu werfen', () => {
    // Genau der LAN-http-Fall: isSecureContext false.
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('crypto', { randomUUID: () => 'sollte-nicht-aufgerufen-werden' });
    const id = randomId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(id).not.toBe('sollte-nicht-aufgerufen-werden');
  });

  it('wirft nicht, wenn crypto.randomUUID gar nicht existiert', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('crypto', {});
    expect(() => randomId()).not.toThrow();
  });

  it('liefert bei aufeinanderfolgenden Aufrufen verschiedene IDs', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('crypto', {});
    const a = randomId();
    const b = randomId();
    expect(a).not.toBe(b);
  });
});
