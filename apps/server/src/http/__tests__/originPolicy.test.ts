import { describe, expect, test } from 'bun:test';
import { allowedOrigins, isCrossSiteRequest } from '../originPolicy';

const base = { configured: [], devWebPort: null };

describe('allowedOrigins (F5)', () => {
  test('leitet die eigene Origin aus dem Host-Header ab, http und https', () => {
    expect(allowedOrigins({ ...base, host: 'mac.local:4000' }).sort()).toEqual([
      'http://mac.local:4000',
      'https://mac.local:4000',
    ]);
  });

  test('LAN-Zugriff über die IP funktioniert (nicht auf localhost festgenagelt)', () => {
    expect(allowedOrigins({ ...base, host: '192.168.1.77:4000' })).toContain(
      'http://192.168.1.77:4000',
    );
  });

  test('im Dev kommt die Vite-Origin dazu (changeOrigin-Falle)', () => {
    const origins = allowedOrigins({ configured: [], devWebPort: 5173, host: 'localhost:4000' });
    expect(origins).toContain('http://localhost:5173');
    expect(origins).toContain('http://localhost:4000');
  });

  test('konfigurierte Origins werden ergänzt', () => {
    expect(
      allowedOrigins({ ...base, host: 'mac.local:4000', configured: ['https://extern.example'] }),
    ).toContain('https://extern.example');
  });

  test('ohne Host-Header bleiben nur die konfigurierten übrig', () => {
    expect(allowedOrigins({ ...base, host: null })).toEqual([]);
  });
});

describe('isCrossSiteRequest (F6)', () => {
  const allowed = ['http://mac.local:4000'];

  test('Sec-Fetch-Site: cross-site wird abgelehnt', () => {
    expect(
      isCrossSiteRequest({ method: 'POST', origin: null, secFetchSite: 'cross-site', allowed }),
    ).toBe(true);
  });

  test('fremde Origin wird abgelehnt', () => {
    expect(
      isCrossSiteRequest({
        method: 'POST',
        origin: 'http://boese.example',
        secFetchSite: null,
        allowed,
      }),
    ).toBe(true);
  });

  /**
   * Der eigentliche Angriffsweg: die Preview läuft auf Port 4173 derselben
   * Site — same-site, also greift SameSite=Lax nicht. Die Origin unterscheidet
   * sich aber und muss abgelehnt werden.
   */
  test('die Preview-Origin auf anderem Port derselben Site wird abgelehnt', () => {
    expect(
      isCrossSiteRequest({
        method: 'POST',
        origin: 'http://mac.local:4173',
        secFetchSite: 'same-site',
        allowed,
      }),
    ).toBe(true);
  });

  test('eigene Origin ist erlaubt', () => {
    expect(
      isCrossSiteRequest({
        method: 'POST',
        origin: 'http://mac.local:4000',
        secFetchSite: 'same-origin',
        allowed,
      }),
    ).toBe(false);
  });

  test('ohne beide Signale wird durchgelassen (curl, Tests)', () => {
    expect(isCrossSiteRequest({ method: 'POST', origin: null, secFetchSite: null, allowed })).toBe(
      false,
    );
  });
});

/**
 * Zweiter Scan, F1 (HIGH, selbst eingebaut): In Produktion läuft auf 5173 kein
 * Vite, sondern die Preview der ERSTEN Sandbox (templates.json: previewPort
 * 5173, der Allokator bevorzugt genau diesen Port). Ein fester Default hätte
 * damit ausgerechnet dem vom Agenten kontrollierten Ursprung vertraut.
 */
describe('Dev-Origin nur bei ausdrücklicher Konfiguration (2. Scan, F1)', () => {
  test('ohne devWebPort wird 5173 NICHT erlaubt', () => {
    const origins = allowedOrigins({ host: 'mac.local:4000', configured: [], devWebPort: null });
    expect(origins).not.toContain('http://mac.local:5173');
    expect(origins).toContain('http://mac.local:4000');
  });

  test('mit gesetztem devWebPort weiterhin erlaubt (Dev-Betrieb)', () => {
    const origins = allowedOrigins({ host: 'mac.local:4000', configured: [], devWebPort: 5173 });
    expect(origins).toContain('http://mac.local:5173');
  });
});

describe('Nachbesserungen aus dem 2. Scan', () => {
  test('F8: Origin "null" gilt als cross-site, nicht als "kein Origin"', () => {
    expect(
      isCrossSiteRequest({
        method: 'POST',
        origin: 'null',
        secFetchSite: null,
        allowed: ['http://a'],
      }),
    ).toBe(true);
  });

  test('F22: über HTTPS wird die http-Variante nicht mehr erlaubt', () => {
    const o = allowedOrigins({ host: 'mac.local', configured: [], devWebPort: null, secure: true });
    expect(o).toContain('https://mac.local');
    expect(o).not.toContain('http://mac.local');
  });

  test('im LAN-Klartext bleiben beide Schemata erlaubt', () => {
    const o = allowedOrigins({
      host: 'mac.local:4000',
      configured: [],
      devWebPort: null,
      secure: false,
    });
    expect(o).toContain('http://mac.local:4000');
  });
});
