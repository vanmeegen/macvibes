/**
 * Health-Check für den Preview-/Dev-Server: erreichbar = irgendeine
 * HTTP-Antwort (auch 3xx/4xx/5xx zählt als „läuft" — der Dev-Server lebt,
 * die App kann trotzdem noch einen Fehler rendern). Timeout → nicht erreichbar.
 *
 * `redirect: 'manual'` ist sicherheitsrelevant (H10): das Ziel ist der
 * Dev-Server IN der untrusted VM, sein `Location`-Header also
 * angreiferkontrolliert. Mit dem Default `follow` würde der HOST-Prozess der
 * Umleitung nachlaufen und damit genau die Ziele erreichen, die die
 * Egress-Policy der VM verwehrt: das Host-Loopback (macvibes selbst, der
 * Credential-Proxy, der lokale Modell-Router) und das gesamte LAN. Für den
 * Health-Check ist die Weiterverfolgung ohne Wert — eine 3xx-Antwort belegt
 * schon, dass der Server lebt.
 */
export async function httpProbe(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}
