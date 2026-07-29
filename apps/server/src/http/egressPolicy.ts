/**
 * Zielprüfung für den Egress-Proxy (F3).
 *
 * Der Proxy ist der einzige Weg der MicroVM ins Netz, und der Agent besitzt
 * seine Credentials per Design. Ohne Zielprüfung erreicht er damit alles, was
 * der HOST erreicht — insbesondere dessen Loopback (macvibes selbst, der
 * Credential-Proxy, das Agent-Gateway) und das gesamte LAN. Genau das ist der
 * Unterschied zwischen „VM darf ins Internet" und „VM darf alles".
 */

/** Öffentlich erreichbare Ports, die eine VM ansteuern darf. */
const DEFAULT_ALLOWED_PORTS = [80, 443];

export interface EgressPolicy {
  allowedPorts: number[];
}

export function defaultEgressPolicy(): EgressPolicy {
  const configured = Bun.env.MACVIBES_EGRESS_PORTS;
  if (!configured) return { allowedPorts: [...DEFAULT_ALLOWED_PORTS] };
  const ports = configured
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
  return { allowedPorts: ports.length > 0 ? ports : [...DEFAULT_ALLOWED_PORTS] };
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
  // IPv4-mapped ::ffff:a.b.c.d — auch in reiner Hex-Schreibweise.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIp(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  const erstesByte = g0 >> 8;
  if ((erstesByte & 0xfe) === 0xfc) return true; // fc00::/7 (ULA)
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 (Link-Local)
  if (erstesByte === 0xff) return true; // Multicast
  return false;
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
