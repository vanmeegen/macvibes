import { describe, expect, test } from 'bun:test';
import { checkTarget, isBlockedIp, type EgressPolicy } from '../egressPolicy';

const policy: EgressPolicy = { allowedPorts: [80, 443] };

describe('isBlockedIp — nicht-öffentliche Bereiche (F3)', () => {
  test.each([
    ['127.0.0.1', 'Loopback — der Host selbst'],
    ['127.1.2.3', 'Loopback-Bereich'],
    ['0.0.0.0', 'dieses Netz'],
    ['10.1.2.3', 'privat'],
    ['172.16.0.1', 'privat, zugleich msb-Host-Gateway'],
    ['172.31.255.254', 'privat, oberes Ende'],
    ['192.168.1.77', 'privat, Marcos LAN'],
    ['169.254.169.254', 'Link-Local, Cloud-Metadaten'],
    ['100.64.0.1', 'CGNAT'],
    ['::1', 'IPv6-Loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped Loopback'],
    ['fd00::1', 'IPv6 ULA'],
    ['fe80::1', 'IPv6 Link-Local'],
  ])('%s ist blockiert (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  test.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['140.82.121.4'],
    ['172.15.0.1'],
    ['172.32.0.1'],
    ['2606:4700::1111'],
  ])('%s ist erlaubt', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});

describe('checkTarget', () => {
  test('öffentliches Ziel auf erlaubtem Port ist ok', () => {
    expect(checkTarget('registry.npmjs.org', 443, ['104.16.0.1'], policy)).toEqual({ ok: true });
  });

  test('Loopback wird abgelehnt und nennt den Grund', () => {
    const verdict = checkTarget('localhost', 443, ['127.0.0.1'], policy);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain('127.0.0.1');
  });

  test('EINE blockierte Adresse genügt (DNS-Rebinding)', () => {
    // Der Angreifer lässt seinen Namen auf eine öffentliche UND eine
    // interne Adresse zeigen und hofft auf die falsche beim Verbinden.
    expect(checkTarget('evil.example', 443, ['93.184.216.34', '127.0.0.1'], policy).ok).toBe(false);
  });

  test('nicht erlaubter Port wird abgelehnt', () => {
    expect(checkTarget('example.com', 22, ['93.184.216.34'], policy).ok).toBe(false);
  });

  test('nicht auflösbarer Name wird abgelehnt', () => {
    expect(checkTarget('gibtsnicht.invalid', 443, [], policy).ok).toBe(false);
  });

  test('unsinniger Port wird abgelehnt', () => {
    expect(checkTarget('example.com', Number.NaN, ['93.184.216.34'], policy).ok).toBe(false);
  });
});

/**
 * 2. Scan, F9: Die Sperrliste verglich IPv6 als Zeichenkette — andere
 * Schreibweisen derselben Adresse rutschten durch.
 */
describe('IPv6 wird numerisch geprüft, nicht als Text (F9)', () => {
  test.each([
    ['0:0:0:0:0:0:0:1', 'ausgeschriebenes Loopback'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', 'voll ausgeschrieben'],
    ['::ffff:7f00:1', 'IPv4-mapped 127.0.0.1 in Hex'],
    ['::ffff:c0a8:101', 'IPv4-mapped 192.168.1.1 in Hex'],
    ['fe80:0:0:0:0:0:0:1', 'Link-Local ausgeschrieben'],
    ['fd12:3456::1', 'ULA'],
    ['FC00::1', 'ULA in Großschreibung'],
    ['ff02::1', 'Multicast'],
  ])('%s ist blockiert (%s)', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  test.each([['2606:4700::1111'], ['2001:db8::1']])('%s bleibt erlaubt', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});
