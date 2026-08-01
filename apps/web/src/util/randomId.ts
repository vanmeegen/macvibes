/**
 * Zufällige ID, die AUCH ohne Secure Context funktioniert.
 *
 * `crypto.randomUUID()` gibt es nur im Secure Context. macvibes läuft im LAN
 * bewusst auch über einfaches http (`http://192.168.x.x:…`) — dort ist
 * `crypto.randomUUID` `undefined`, und ein Aufruf im Feld-Initialisierer eines
 * Stores wirft beim App-Bootstrap, sodass React nie mountet (weiße Seite). Für
 * die Zwecke hier (Betrachter-Kennung, H11) reicht eine nicht-kryptografische
 * ID vollkommen — sie muss nur pro Tab eindeutig sein, nicht unvorhersehbar.
 */
export function randomId(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.randomUUID === 'function' && globalThis.isSecureContext) {
    return c.randomUUID();
  }
  // Fallback: Zeit + zwei Zufallsblöcke. Kollision ist praktisch
  // ausgeschlossen und wäre ohnehin folgenlos (der Server zählt nur mit).
  const teil = (): string => Math.floor(Math.random() * 1e9).toString(36);
  return `${Date.now().toString(36)}-${teil()}-${teil()}`;
}
