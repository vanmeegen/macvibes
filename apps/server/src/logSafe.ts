/**
 * Log-Sanitizer (H8). Mehrere Log-Senken bekommen Text aus der untrusted VM
 * oder von unangemeldeten Clients: Sandbox-Namen und Query-Parameter am
 * Agent-Gateway, WebSocket-Close-Gründe, abgewiesene Proxy-Pfade. Ungefiltert
 * kann ein Zeilenumbruch darin eine zweite, frei erfundene Log-Zeile
 * vortäuschen (Log-Injection) und eine ANSI-Sequenz das Terminal des
 * Betreibers umfärben.
 *
 * Deshalb: Steuerzeichen sichtbar escapen statt entfernen (der Wert bleibt für
 * die Diagnose erkennbar) und die Länge deckeln, damit die VM das Log nicht
 * flutet.
 */

/** Maximale Länge eines gelogten Fremdwerts; darüber wird mit … gekürzt. */
const MAX_LOG_CHARS = 200;

const ESCAPES = new Map<string, string>([
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
  ['\x1b', '\\x1b'],
]);

export function logSafe(value: string | null | undefined): string {
  if (value === null) return '<null>';
  if (value === undefined) return '<undefined>';

  // eslint-disable-next-line no-control-regex -- genau diese Zeichen sind das Ziel
  const escaped = value.replace(/[\x00-\x1f\x7f]/g, (ch) => {
    const known = ESCAPES.get(ch);
    if (known !== undefined) return known;
    return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`;
  });

  if (escaped.length <= MAX_LOG_CHARS) return escaped;
  return `${escaped.slice(0, MAX_LOG_CHARS)}…`;
}
