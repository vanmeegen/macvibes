/**
 * Zielprüfung für den Egress-Proxy (F3).
 *
 * Der Proxy ist der einzige Weg der MicroVM ins Netz, und der Agent besitzt
 * seine Credentials per Design. Ohne Zielprüfung erreicht er damit alles, was
 * der HOST erreicht — insbesondere dessen Loopback (macvibes selbst, der
 * Credential-Proxy, das Agent-Gateway) und das gesamte LAN. Genau das ist der
 * Unterschied zwischen „VM darf ins Internet" und „VM darf alles".
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
 * Nicht-öffentliche Adressbereiche: Loopback, private Netze, Link-Local
 * (inkl. Cloud-Metadaten 169.254.169.254), CGNAT, „dieses Netz" und die
 * IPv6-Entsprechungen samt IPv4-mapped-Schreibweise.
 */
export function isBlockedIp(ip: string): boolean {
  const normalized = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

  // IPv4-mapped IPv6 (::ffff:127.0.0.1) auf die IPv4-Prüfung zurückführen.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const candidate = mapped?.[1] ?? normalized;

  const v4 = ipv4Parts(candidate);
  if (v4) {
    const [a = 0, b = 0] = v4;
    if (a === 0) return true; // 0.0.0.0/8 "dieses Netz"
    if (a === 127) return true; // Loopback
    if (a === 10) return true; // privat
    if (a === 172 && b >= 16 && b <= 31) return true; // privat (auch msb-Gateway)
    if (a === 192 && b === 168) return true; // privat
    if (a === 169 && b === 254) return true; // Link-Local + Metadaten-Endpunkt
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // Multicast + reserviert
    return false;
  }

  const v6 = ipv6Groups(candidate);
  if (v6 === null) return false;
  // Numerisch statt per Zeichenkette (2. Scan, F9): sonst rutschen andere
  // Schreibweisen derselben Adresse durch — `0:0:0:0:0:0:0:1` ist ebenso
  // Loopback wie `::1`, und `::ffff:7f00:1` ebenso 127.0.0.1 wie `::ffff:127.0.0.1`.
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = v6;
  if (v6.every((g) => g === 0)) return true; // ::
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return true; // ::1
  }
  // Nachschärfung von F9: NICHT nur IPv4-mapped (::ffff:…) trägt eine
  // eingebettete IPv4 — auch IPv4-compatible (::/96), SIIT (::ffff:0:0/96),
  // 6to4 (2002::/16) und NAT64 (64:ff9b::/96 bzw. 64:ff9b:1::/48) tun das,
  // und alle vier liefen bisher an der Sperre vorbei. Auf DIESEM macOS/
  // Bun-Stack ist das nicht ausnutzbar (empirisch geprüft: keine der vier
  // Formen erreicht per Bun.connect einen IPv4-Loopback-Listener, die
  // gemappten Formen schon) — auf anderen Plattformen (bestimmte
  // Linux-sysctl, NAT64-Gateway im LAN) aber potenziell doch. Wir schließen
  // die Lücke, weil diese Liste die autoritative Egress-Grenze der MicroVM
  // ist, nicht weil heute ein Pfad offen wäre. Geprüft wird jeweils NUR die
  // eingebettete Adresse — ein 6to4/NAT64-Ziel mit öffentlicher IPv4 bleibt
  // erlaubt, sonst wäre der halbe Übergangsverkehr des Internets gesperrt.
  const eingebettet = eingebetteteIpv4(g0, g1, g2, g3, g4, g5, g6, g7);
  if (eingebettet !== null) return isBlockedIp(eingebettet);
  const erstesByte = g0 >> 8;
  if ((erstesByte & 0xfe) === 0xfc) return true; // fc00::/7 (ULA)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 (Link-Local)
  if (erstesByte === 0xff) return true; // Multicast
  return false;
}

/**
 * Extrahiert die eingebettete IPv4-Adresse aus den IPv6-Übergangsformen, die
 * eine tragen — damit `isBlockedIp` sie einheitlich nach den IPv4-Regeln
 * bewertet. `::` und `::1` sind vorher schon gefangen; sie fielen aber auch
 * hier richtig aus (0.0.0.0 bzw. 0.0.0.1 liegen in 0.0.0.0/8 → blockiert),
 * die Reihenfolge der Prüfungen ist also nicht tragend. Bewusst NICHT dabei:
 * Teredo (2001::/32) bettet die IPv4 XOR-verschleiert ein und braucht ohnehin
 * einen Relay — das wäre Scheingenauigkeit ohne realen Pfad.
 */
function eingebetteteIpv4(
  g0: number,
  g1: number,
  g2: number,
  g3: number,
  g4: number,
  g5: number,
  g6: number,
  g7: number,
): string | null {
  const v4 = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    // ::ffff:a.b.c.d — IPv4-mapped (RFC 4291), der bisher einzige Fall.
    if (g4 === 0 && g5 === 0xffff) return v4(g6, g7);
    // ::a.b.c.d — IPv4-compatible (RFC 4291, deprecated, wird aber geparst).
    if (g4 === 0 && g5 === 0) return v4(g6, g7);
    // ::ffff:0:a.b.c.d — SIIT/„IPv4-translated" (RFC 2765).
    if (g4 === 0xffff && g5 === 0) return v4(g6, g7);
    return null;
  }
  // 2002:ab:cd:: — 6to4 (RFC 3056): die IPv4 steckt in den Gruppen 1+2.
  if (g0 === 0x2002) return v4(g1, g2);
  // 64:ff9b::a.b.c.d — NAT64 well-known prefix (RFC 6052). Das lokale
  // 64:ff9b:1::/48 (RFC 8215) nehmen wir mit: ein NAT64-Gateway im LAN würde
  // genau darüber interne IPv4-Ziele erreichbar machen. Wir prüfen die
  // übliche /96-Einbettung (IPv4 in den letzten 32 Bit); das Operator-Suffix
  // in den Gruppen 3–5 ist dafür beliebig.
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return v4(g6, g7);
    if (g2 === 1) return v4(g6, g7);
  }
  return null;
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
  const blocked = resolved.find((ip) => isBlockedIp(ip));
  if (blocked !== undefined) {
    return { ok: false, reason: `${host} zeigt auf die nicht-öffentliche Adresse ${blocked}` };
  }
  return { ok: true };
}
