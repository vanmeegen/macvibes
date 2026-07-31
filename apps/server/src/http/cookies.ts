export const SESSION_COOKIE = 'macvibes_session';

/**
 * Minimale Typung des CookieStore aus @whatwg-node/server-plugin-cookies —
 * das Plugin hängt ihn an den Request, liefert aber keine Request-Augmentation.
 */
export interface CookieStoreLike {
  get(name: string): Promise<{ name: string; value: string } | undefined>;
  set(init: {
    name: string;
    value: string;
    expires: number | null;
    path: string;
    domain: string | null;
    httpOnly?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
    secure?: boolean;
  }): Promise<void>;
  delete(name: string): Promise<void>;
}

export function cookieStoreOf(request: Request): CookieStoreLike {
  const store = (request as Request & { cookieStore?: CookieStoreLike }).cookieStore;
  if (!store) {
    throw new Error('CookieStore fehlt — useCookies-Plugin nicht aktiv?');
  }
  return store;
}

/**
 * Wie oft schickt der Browser unser Session-Cookie? (H2)
 *
 * Mehr als einmal heißt: jemand hat ein zweites Cookie gleichen Namens
 * untergeschoben. Genau das kann agent-geschriebenes JS in der Preview: sie
 * läuft auf demselben Host (nur anderer Port), und Cookies sind nicht
 * portgebunden. Unser Cookie überschreiben kann sie nicht (httpOnly), aber ein
 * zweites auf einem anderen Pfad setzen — der Browser sendet dann beide, den
 * spezifischeren Pfad zuerst.
 */
function cookieValues(cookieHeader: string | null, name: string): string[] {
  if (cookieHeader === null || cookieHeader.length === 0) return [];
  const werte: string[] = [];
  for (const teil of cookieHeader.split(';')) {
    const eq = teil.indexOf('=');
    if (eq === -1) continue;
    if (teil.slice(0, eq).trim() === name) werte.push(teil.slice(eq + 1).trim());
  }
  return werte;
}

export function countSessionCookies(cookieHeader: string | null): number {
  return cookieValues(cookieHeader, SESSION_COOKIE).length;
}

/**
 * Der EINE Wert eines Cookies aus einem rohen Header — null, wenn er fehlt oder
 * mehrdeutig ist (H2, s. o.).
 *
 * Existiert, damit die H2-Regel nur an EINER Stelle steht. Das Preview-Gateway
 * ist ein rohes `Bun.serve` ohne den CookieStore des Yoga-Plugins und kann
 * `readSessionToken` deshalb nicht nutzen — es hatte die Regel folglich ein
 * zweites Mal selbst implementiert. Zwei Kopien derselben
 * Sicherheitsentscheidung driften irgendwann auseinander.
 *
 * Liefert den Wert UNDEKODIERT: das Gateway dekodiert selbst gekapselt (H7),
 * weil ein `%ZZ` sonst einen unbehandelten URIError vor der Auth-Prüfung wirft.
 */
export function singleCookieValue(cookieHeader: string | null, name: string): string | null {
  const werte = cookieValues(cookieHeader, name);
  return werte.length === 1 ? (werte[0] as string) : null;
}

export async function readSessionToken(request: Request): Promise<string | null> {
  // Mehrdeutig = nicht angemeldet (H2). Welcher der beiden Werte echt ist, kann
  // der Server nicht entscheiden — den untergeschobenen zu nehmen wäre
  // Session-Fixation, also lieber niemanden anmelden. Für den Angreifer bleibt
  // dann nur, die Sitzung des Opfers zu stören, nicht sie zu übernehmen.
  const anzahl = countSessionCookies(request.headers.get('cookie'));
  if (anzahl > 1) {
    console.warn(
      `Mehrdeutiges Session-Cookie (${anzahl}×) — Request gilt als nicht angemeldet. ` +
        'Mögliches Cookie-Tossing aus einer Preview.',
    );
    return null;
  }
  const cookie = await cookieStoreOf(request).get(SESSION_COOKIE);
  return cookie?.value ?? null;
}

/**
 * Läuft dieser Request über HTTPS? (F23)
 *
 * `secure` war hartkodiert false, während das dokumentierte Deployment TLS in
 * Caddy terminiert — das Cookie war also auch im HTTPS-Betrieb ungeschützt,
 * und weil Cookies nicht portgebunden sind, greift ein Angreifer im LAN es
 * über den weiterhin offenen Klartextport ab. Fest auf true wäre aber
 * genauso falsch: im reinen LAN-http käme das Cookie nie an (Login-Schleife
 * ohne Fehlermeldung). Deshalb pro Request abgeleitet.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded !== null) return forwarded.split(',')[0]?.trim() === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function writeSessionCookie(
  request: Request,
  token: string,
  expiresAt: Date,
): Promise<void> {
  await cookieStoreOf(request).set({
    name: SESSION_COOKIE,
    value: token,
    expires: expiresAt.getTime(),
    path: '/',
    domain: null,
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(request),
  });
}

export async function clearSessionCookie(request: Request): Promise<void> {
  await cookieStoreOf(request).set({
    name: SESSION_COOKIE,
    value: '',
    expires: 0,
    path: '/',
    domain: null,
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(request),
  });
}
