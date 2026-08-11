/**
 * Zielprüfung für den Egress-Proxy (F3).
 *
 * Der Proxy ist der einzige Weg der MicroVM ins Netz, und der Agent besitzt
 * seine Credentials per Design. Ohne Zielprüfung erreicht er damit alles, was
 * der HOST erreicht — insbesondere dessen Loopback (macvibes selbst, der
 * Credential-Proxy, das Agent-Gateway) und das gesamte LAN. Genau das ist der
 * Unterschied zwischen „VM darf ins Internet" und „VM darf alles".
 *
 * Seit dem Umbau auf eine ALLOWLIST gilt: erlaubt ist NUR global routbares
 * Unicast. Die frühere Blockliste musste jeden Spezialbereich der
 * IANA-Special-Purpose-Registry einzeln kennen und scheiterte bei Lücken
 * OFFEN — 192.0.0.0/24, 198.18.0.0/15, 192.88.99.0/24 und 2001:db8::/32
 * rutschten so durch, und Unparsebares galt als erlaubt. Die Allowlist
 * scheitert GESCHLOSSEN: Was nicht als IPv4 oder IPv6 parsebar ist oder in
 * einem Spezialbereich liegt, wird abgelehnt. IPv6 ist nur innerhalb von
 * 2000::/3 (Global Unicast) überhaupt zulässig — das erledigt ::1, fe80::/10,
 * fc00::/7, ff00::/8, ::/96, IPv4-mapped/SIIT, NAT64 (64:ff9b::/96) und
 * SRv6 (5f00::/16) in einer einzigen Regel statt in je einer eigenen.
 */

import { DEFAULT_EGRESS_ALLOWED_PORTS } from '../config';

export interface EgressPolicy {
  allowedPorts: number[];
}

/**
 * Policy mit den Default-Zielports. Der Env-Override (MACVIBES_EGRESS_PORTS)
 * wird seit M6 zentral in config.ts geparst — die Composition Root reicht
 * `config.egress.allowedPorts` explizit herein (createTargetChecker in
 * index.ts); dieser Default trägt nur noch Tests und DI-Nähte.
 */
export function defaultEgressPolicy(): EgressPolicy {
  return { allowedPorts: [...DEFAULT_EGRESS_ALLOWED_PORTS] };
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((p) => Number(p));
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return numbers;
}

/**
 * Allowlist: true NUR für global routbares Unicast. Alles andere — die
 * Spezialbereiche der IANA-Registry ebenso wie unparsebare Eingaben — wird
 * abgelehnt (fail-closed). Verhaltensänderung gegenüber der alten Blockliste:
 * `isBlockedIp('abc')` war false (durchgelassen), `isAllowedIp('abc')` ist
 * ebenfalls false (abgelehnt) — Unfug fällt jetzt auf die sichere Seite.
 */
export function isAllowedIp(ip: string): boolean {
  const normalized = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

  const v4 = ipv4Parts(normalized);
  if (v4) return istGlobalRoutbaresIpv4(v4);

  const v6 = ipv6Groups(normalized);
  if (v6) return istGlobalRoutbaresIpv6(v6);

  return false; // weder IPv4 noch IPv6 parsebar → fail-closed
}

/**
 * IPv4-Spezialbereiche laut IANA Special-Purpose Address Registry, soweit
 * NICHT global routbar. Bewusst NICHT gesperrt, weil laut Registry „Globally
 * Reachable": 192.31.196.0/24 (AS112), 192.52.193.0/24 (AMT),
 * 192.175.48.0/24 (AS112 Direct Delegation).
 */
function istGlobalRoutbaresIpv4(v4: number[]): boolean {
  const [a = 0, b = 0, c = 0] = v4;
  if (a === 0) return false; // 0.0.0.0/8 „dieses Netz"
  if (a === 10) return false; // privat (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
  if (a === 127) return false; // Loopback
  if (a === 169 && b === 254) return false; // Link-Local + Cloud-Metadaten
  if (a === 172 && b >= 16 && b <= 31) return false; // privat (auch msb-Gateway)
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24 IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4-Relay-Anycast (deprecated, RFC 7526)
  if (a === 192 && b === 168) return false; // privat (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15 Benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // Multicast (224/4) + reserviert (240/4) + Broadcast
  return true;
}

/**
 * IPv6: nur 2000::/3 (Global Unicast) kommt überhaupt in Frage — eine einzige
 * Bereichsprüfung statt einer Einzelsperre je Sonderfall. Innerhalb davon
 * bleiben genau vier Spezialbereiche zu sperren, plus 6to4 als Sonderfall:
 * dort entscheidet die eingebettete IPv4 (Gruppen 1+2, RFC 3056), sonst wäre
 * sämtlicher 6to4-Verkehr tot — 2002:808:808:: (8.8.8.8) muss durchgehen,
 * 2002:7f00:1:: (127.0.0.1) nicht. Die übrigen Übergangsformen mit
 * eingebetteter IPv4 (IPv4-mapped ::ffff:…, IPv4-compatible ::/96, SIIT
 * ::ffff:0:0/96, NAT64 64:ff9b::/96 und 64:ff9b:1::/48) liegen komplett
 * außerhalb von 2000::/3 und sind damit pauschal abgelehnt — strenger als
 * früher (ein NAT64-Ziel mit öffentlicher IPv4 war erlaubt), aber korrekt:
 * der Host-Resolver liefert öffentliche Ziele als normale A/AAAA-Adressen,
 * und Teredo (2001::/32) bettet seine IPv4 ohnehin XOR-verschleiert ein,
 * ist also nicht sinnvoll prüfbar → komplett gesperrt.
 */
function istGlobalRoutbaresIpv6(v6: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0] = v6;
  if ((g0 & 0xe000) !== 0x2000) return false; // außerhalb 2000::/3
  if (g0 === 0x2002) {
    // 6to4: die eingebettete IPv4 entscheidet.
    return istGlobalRoutbaresIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  }
  if (g0 === 0x2001) {
    if (g1 === 0) return false; // 2001::/32 Teredo
    if (g1 === 0x0002 && g2 === 0) return false; // 2001:2::/48 Benchmarking
    if ((g1 & 0xfff0) === 0x0020) return false; // 2001:20::/28 ORCHIDv2
    if (g1 === 0x0db8) return false; // 2001:db8::/32 Dokumentation
  }
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false; // 3fff::/20 Dokumentation (RFC 9637)
  return true;
}

/** Zerlegt eine IPv6-Adresse in ihre acht 16-Bit-Gruppen; null bei Unfug. */
function ipv6Groups(ip: string): number[] | null {
  if (!ip.includes(':')) return null;
  let rest = ip;
  // Eingebettete IPv4-Notation in zwei Hex-Gruppen überführen.
  const v4Ende = rest.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Ende) {
    const teile = ipv4Parts(v4Ende[1] as string);
    if (teile === null) return null;
    const [a = 0, b = 0, c = 0, d = 0] = teile;
    rest = `${rest.slice(0, v4Ende.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [links, rechts, zuviel] = rest.split('::');
  if (zuviel !== undefined) return null;
  const zerlege = (teil: string): number[] | null => {
    if (teil === '') return [];
    const gruppen: number[] = [];
    for (const g of teil.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      gruppen.push(Number.parseInt(g, 16));
    }
    return gruppen;
  };
  const vorne = zerlege(links ?? '');
  const hinten = rechts === undefined ? [] : zerlege(rechts);
  if (vorne === null || hinten === null) return null;
  if (rechts === undefined) return vorne.length === 8 ? vorne : null;
  const fehlend = 8 - vorne.length - hinten.length;
  if (fehlend < 0) return null;
  return [...vorne, ...Array<number>(fehlend).fill(0), ...hinten];
}

export type TargetVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Prüft ein Ziel gegen die Policy. `resolved` sind ALLE vom Host aufgelösten
 * Adressen — es genügt eine blockierte, sonst bliebe ein Rebinding-Fenster
 * zwischen Prüfung und Verbindungsaufbau offen.
 */
export function checkTarget(
  host: string,
  port: number,
  resolved: string[],
  policy: EgressPolicy,
): TargetVerdict {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: `ungültiger Port ${port}` };
  }
  if (!policy.allowedPorts.includes(port)) {
    return { ok: false, reason: `Port ${port} nicht erlaubt` };
  }
  if (resolved.length === 0) {
    return { ok: false, reason: `${host} nicht auflösbar` };
  }
  const blocked = resolved.find((ip) => !isAllowedIp(ip));
  if (blocked !== undefined) {
    return { ok: false, reason: `${host} zeigt auf die nicht global routbare Adresse ${blocked}` };
  }
  return { ok: true };
}
