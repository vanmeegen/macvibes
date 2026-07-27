import { describe, expect, test } from 'bun:test';
import { isSecureRequest } from '../cookies';

/**
 * F23: `secure` war hartkodiert false. Fest auf true wäre genauso falsch —
 * im LAN-http käme das Cookie nie an. Deshalb pro Request abgeleitet.
 */
describe('isSecureRequest (F23)', () => {
  test('hinter einem TLS-Frontend (Caddy) gilt der Forwarded-Header', () => {
    const request = new Request('http://mac.local:4000/graphql', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(isSecureRequest(request)).toBe(true);
  });

  test('mehrere Proxy-Einträge: der erste zählt', () => {
    const request = new Request('http://mac.local:4000/graphql', {
      headers: { 'x-forwarded-proto': 'https, http' },
    });
    expect(isSecureRequest(request)).toBe(true);
  });

  test('direkter https-Request ist sicher', () => {
    expect(isSecureRequest(new Request('https://mac.local/graphql'))).toBe(true);
  });

  test('reines LAN-http bleibt unsicher — sonst käme das Cookie nie an', () => {
    expect(isSecureRequest(new Request('http://192.168.1.77:4000/graphql'))).toBe(false);
  });

  test('ein gefälschter Forwarded-Header über http macht es nicht sicher', () => {
    const request = new Request('http://mac.local:4000/graphql', {
      headers: { 'x-forwarded-proto': 'http' },
    });
    expect(isSecureRequest(request)).toBe(false);
  });
});
