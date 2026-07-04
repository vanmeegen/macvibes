/**
 * Health-Check für den Preview-/Dev-Server: erreichbar = irgendeine
 * HTTP-Antwort (auch 4xx/5xx zählt als „läuft" — der Dev-Server lebt,
 * die App kann trotzdem noch einen Fehler rendern). Timeout → nicht erreichbar.
 */
export async function httpProbe(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
