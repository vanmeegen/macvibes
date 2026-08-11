import { describe, expect, test } from 'bun:test';
import { checkTarget, isAllowedIp, type EgressPolicy } from '../egressPolicy';

const policy: EgressPolicy = { allowedPorts: [80, 443] };

/**
 * F3, Umbau auf Allowlist: erlaubt ist NUR global routbares Unicast. Eine
 * Blockliste muss jeden Spezialbereich der IANA-Registry einzeln kennen und
 * scheitert bei Lücken OFFEN (so rutschten 192.0.0.0/24, 198.18.0.0/15,
 * 192.88.99.0/24 und 2001:db8::/32 bisher durch). Die Allowlist scheitert
 * GESCHLOSSEN — auch bei unparsebaren Eingaben.
 */
describe('isAllowedIp — IPv4-Spezialbereiche werden abgelehnt (inkl. Bereichsgrenzen)', () => {
  test.each([
    ['0.0.0.0', '„dieses Netz" 0.0.0.0/8'],
    ['0.255.255.255', 'oberes Ende 0.0.0.0/8'],
    ['10.0.0.0', 'privat 10.0.0.0/8'],
    ['10.255.255.255', 'privat, oberes Ende'],
    ['100.64.0.0', 'CGNAT 100.64.0.0/10, unteres Ende'],
    ['100.127.255.255', 'CGNAT, oberes Ende'],
    ['127.0.0.1', 'Loopback — der Host selbst'],
    ['127.255.255.255', 'Loopback, oberes Ende'],
    ['169.254.0.1', 'Link-Local 169.254.0.0/16'],
    ['169.254.169.254', 'Link-Local, Cloud-Metadaten-Endpunkt'],
    ['172.16.0.1', 'privat 172.16.0.0/12, zugleich msb-Host-Gateway'],
    ['172.31.255.254', 'privat, oberes Ende'],
    ['192.0.0.1', 'IETF Protocol Assignments 192.0.0.0/24 — fehlte in der Blockliste'],
    ['192.0.0.255', 'oberes Ende 192.0.0.0/24'],
    ['192.0.2.1', 'TEST-NET-1 192.0.2.0/24'],
    ['192.88.99.1', '6to4-Relay-Anycast 192.88.99.0/24 — fehlte in der Blockliste'],
    ['192.168.1.77', 'privat 192.168.0.0/16, Marcos LAN'],
    ['192.168.255.255', 'privat, oberes Ende'],
    ['198.18.0.1', 'Benchmarking 198.18.0.0/15 — fehlte in der Blockliste'],
    ['198.19.255.255', 'Benchmarking, oberes Ende'],
    ['198.51.100.1', 'TEST-NET-2 198.51.100.0/24'],
    ['203.0.113.1', 'TEST-NET-3 203.0.113.0/24'],
    ['224.0.0.1', 'Multicast 224.0.0.0/4'],
    ['239.255.255.255', 'Multicast, oberes Ende'],
    ['240.0.0.1', 'reserviert 240.0.0.0/4'],
    ['255.255.255.255', 'Broadcast'],
  ])('%s wird abgelehnt (%s)', (ip) => {
    expect(isAllowedIp(ip)).toBe(false);
  });

  // Die Nachbarn der Spezialbereiche MÜSSEN erlaubt bleiben — eine zu grobe
  // Maske würde legitime öffentliche Netze sperren und das Produkt brechen.
  test.each([
    ['9.255.255.255', 'direkt unter 10/8'],
    ['11.0.0.0', 'direkt über 10/8'],
    ['100.63.255.255', 'direkt unter CGNAT'],
    ['100.128.0.0', 'direkt über CGNAT'],
    ['126.255.255.255', 'direkt unter Loopback'],
    ['128.0.0.0', 'direkt über Loopback'],
    ['169.253.255.255', 'direkt unter Link-Local'],
    ['169.255.0.0', 'direkt über Link-Local'],
    ['172.15.255.255', 'direkt unter 172.16/12'],
    ['172.32.0.1', 'direkt über 172.16/12'],
    ['192.0.1.1', 'zwischen 192.0.0/24 und TEST-NET-1'],
    ['192.0.3.1', 'direkt über TEST-NET-1'],
    ['192.88.98.255', 'direkt unter 6to4-Relay'],
    ['192.88.100.0', 'direkt über 6to4-Relay'],
    ['192.167.255.255', 'direkt unter 192.168/16'],
    ['192.169.0.0', 'direkt über 192.168/16'],
    ['198.17.255.255', 'direkt unter Benchmarking'],
    ['198.20.0.0', 'direkt über Benchmarking'],
    ['198.51.99.1', 'direkt unter TEST-NET-2'],
    ['198.51.101.1', 'direkt über TEST-NET-2'],
    ['203.0.112.1', 'direkt unter TEST-NET-3'],
    ['203.0.114.1', 'direkt über TEST-NET-3'],
    ['223.255.255.255', 'direkt unter Multicast'],
  ])('%s bleibt erlaubt (%s)', (ip) => {
    expect(isAllowedIp(ip)).toBe(true);
  });
});

describe('isAllowedIp — IPv6 außerhalb 2000::/3 ist pauschal abgelehnt', () => {
  test.each([
    ['::', 'unspecified'],
    ['::1', 'Loopback'],
    ['0:0:0:0:0:0:0:1', 'Loopback ausgeschrieben'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', 'Loopback voll ausgeschrieben'],
    ['::ffff:127.0.0.1', 'IPv4-mapped Loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped Loopback in Hex'],
    ['::ffff:c0a8:101', 'IPv4-mapped 192.168.1.1'],
    ['::ffff:8.8.8.8', 'IPv4-mapped — außerhalb 2000::/3, fail-closed auch bei öffentlicher IPv4'],
    ['::127.0.0.1', 'IPv4-compatible Loopback'],
    ['::808:808', 'IPv4-compatible — außerhalb 2000::/3'],
    ['::ffff:0:7f00:1', 'SIIT/IPv4-translated Loopback'],
    ['64:ff9b::7f00:1', 'NAT64 well-known mit Loopback'],
    ['64:ff9b::127.0.0.1', 'NAT64 well-known in Punktnotation'],
    ['64:ff9b::808:808', 'NAT64 — außerhalb 2000::/3, pauschal abgelehnt'],
    ['64:ff9b:1::7f00:1', 'lokales NAT64 (RFC 8215)'],
    ['100::1', 'Discard-Only (RFC 6666)'],
    ['fe80::1', 'Link-Local'],
    ['fe80:0:0:0:0:0:0:1', 'Link-Local ausgeschrieben'],
    ['febf::1', 'Link-Local, oberes Ende fe80::/10'],
    ['fc00::1', 'ULA fc00::/7'],
    ['FC00::1', 'ULA in Großschreibung'],
    ['fd12:3456::1', 'ULA fd00::/8'],
    ['fec0::1', 'deprecated Site-Local'],
    ['ff02::1', 'Multicast'],
    ['1fff:ffff::1', 'direkt unter 2000::/3'],
    ['4000::1', 'direkt über 2000::/3'],
    ['5f00::1', 'SRv6 SIDs (RFC 9602) — außerhalb 2000::/3'],
  ])('%s wird abgelehnt (%s)', (ip) => {
    expect(isAllowedIp(ip)).toBe(false);
  });
});

describe('isAllowedIp — Spezialbereiche INNERHALB 2000::/3', () => {
  test.each([
    ['2001::1', 'Teredo 2001::/32 — IPv4 XOR-verschleiert, komplett abgelehnt'],
    ['2001:0:ffff:ffff:ffff:ffff:ffff:ffff', 'Teredo, oberes Ende'],
    ['2001:2::1', 'Benchmarking 2001:2::/48'],
    ['2001:2:0:ffff::1', 'Benchmarking, im /48'],
    ['2001:20::1', 'ORCHIDv2 2001:20::/28'],
    ['2001:2f:ffff::1', 'ORCHIDv2, oberes Ende'],
    ['2001:db8::1', 'Dokumentation 2001:db8::/32 — fehlte in der Blockliste'],
    ['2001:db8:ffff::1', 'Dokumentation, im /32'],
    ['3fff::1', 'Dokumentation 3fff::/20 (RFC 9637)'],
    ['3fff:fff::1', 'Dokumentation, im /20'],
    ['2002:7f00:1::', '6to4 mit eingebettetem Loopback 127.0.0.1'],
    ['2002:c0a8:101::', '6to4 mit eingebettetem 192.168.1.1'],
    ['2002:a9fe:a9fe::', '6to4 mit eingebettetem Metadaten-Endpunkt'],
    ['2002::', '6to4 mit eingebettetem 0.0.0.0'],
    ['2002:c000:1::', '6to4 mit eingebettetem 192.0.0.1 — neue IPv4-Regel greift auch hier'],
  ])('%s wird abgelehnt (%s)', (ip) => {
    expect(isAllowedIp(ip)).toBe(false);
  });

  // Die Grenzen der Ausnahmen exakt: Nachbarn der Spezialbereiche innerhalb
  // 2000::/3 sind reguläres Global Unicast und müssen erlaubt bleiben.
  test.each([
    ['2001:1::1', 'direkt über Teredo (PCP-Anycast, global erreichbar)'],
    ['2001:2:1::1', 'direkt über Benchmarking-/48'],
    ['2001:1f::1', 'direkt unter ORCHIDv2'],
    ['2001:30::1', 'direkt über ORCHIDv2 (Drone Remote ID, global erreichbar)'],
    ['2001:db7:ffff::1', 'direkt unter Doku-/32'],
    ['2001:db9::1', 'direkt über Doku-/32'],
    ['2001:4860:4860::8888', 'Google DNS — in 2001::/16, aber NICHT in Teredo 2001::/32'],
    ['3fff:1000::1', 'direkt über Doku-/20'],
  ])('%s bleibt erlaubt (%s)', (ip) => {
    expect(isAllowedIp(ip)).toBe(true);
  });
});

/**
 * Fail-closed: Was kein IPv4 und kein IPv6 ist, wird ABGELEHNT. Die alte
 * Blockliste ließ Unparsebares durch (isBlockedIp('abc') === false) — bei
 * einer Sicherheitsgrenze ist das die falsche Richtung.
 */
describe('isAllowedIp — unparsebare Eingaben werden abgelehnt (fail-closed)', () => {
  test.each([
    ['', 'leer'],
    ['   ', 'nur Whitespace'],
    ['abc', 'kein Adressformat'],
    ['999.1.1.1', 'Oktett > 255'],
    ['1.2.3', 'zu wenige Oktette'],
    ['1.2.3.4.5', 'zu viele Oktette'],
    ['1.2.3.256', 'Oktett-Grenze überschritten'],
    [':::1', 'doppelte ::-Kompression'],
    ['2001:db8::1::2', 'zwei ::'],
    ['12345::1', 'Hex-Gruppe zu lang'],
    ['2001:db8:zzzz::1', 'keine Hex-Ziffern'],
    ['1:2:3:4:5:6:7:8:9', 'zu viele Gruppen'],
    ['1:2:3:4:5:6:7', 'zu wenige Gruppen ohne ::'],
    ['example.com', 'Hostname statt IP'],
  ])('%s wird abgelehnt (%s)', (ip) => {
    expect(isAllowedIp(ip)).toBe(false);
  });
});

/**
 * Regressionsschutz fürs PRODUKT: die VM MUSS das öffentliche Internet
 * erreichen (npm-Registry, GitHub, Anthropic-API). Fällt hier etwas um,
 * kann kein Agent mehr arbeiten.
 */
describe('isAllowedIp — global routbares Unicast bleibt erlaubt', () => {
  test.each([
    ['8.8.8.8', 'Google DNS'],
    ['1.1.1.1', 'Cloudflare DNS'],
    ['93.184.216.34', 'example.com'],
    ['140.82.121.4', 'GitHub'],
    ['104.16.0.1', 'Cloudflare (npm-Registry-CDN)'],
    ['160.79.104.10', 'Anthropic API'],
    ['2606:4700:4700::1111', 'Cloudflare DNS v6'],
    ['2606:4700::1111', 'Cloudflare v6'],
    ['2001:4860:4860::8888', 'Google DNS v6 — Teredo-Grenze exakt'],
    ['2a00::1', 'RIPE-Raum'],
    ['2600::1', 'ARIN-Raum'],
    ['2000::1', 'unterste Adresse in 2000::/3 (Global Unicast per IANA-Zuteilung)'],
    ['3fff:ffff::1', 'oberes Ende 2000::/3 — außerhalb des Doku-/20'],
    ['3ffe::1', 'ehemals 6bone (an IANA zurückgegeben, kein Spezialbereich mehr)'],
    ['2002:808:808::', '6to4 mit ÖFFENTLICHER 8.8.8.8'],
    ['2002:5db8:d822::', '6to4 mit öffentlicher 93.184.216.34'],
    ['[2606:4700:4700::1111]', 'Bracket-Notation aus URLs'],
    [' 8.8.8.8 ', 'mit Whitespace'],
  ])('%s bleibt erlaubt (%s)', (ip) => {
    expect(isAllowedIp(ip)).toBe(true);
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

  test('unparsebares Auflösungsergebnis wird abgelehnt (fail-closed)', () => {
    expect(checkTarget('kaputt.example', 443, ['not-an-ip'], policy).ok).toBe(false);
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
