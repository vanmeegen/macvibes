import { describe, expect, test } from 'bun:test';
import {
  countSessionCookies,
  isSecureRequest,
  readSessionToken,
  type CookieStoreLike,
} from '../cookies';

/**
 * F23: `secure` war hartkodiert false. Fest auf true wäre genauso falsch —
 * im LAN-http käme das Cookie nie an. Deshalb pro Request abgeleitet.
 */
describe('isSecureRequest (F23)', () => {
  test('hinter einem TLS-Frontend (Caddy) gilt der Forwarded-Header', () => {
    const request = new Request('http://mac.local:4000/graphql', {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(isSecureRequest(request)).toBe(true);
  });

  test('mehrere Proxy-Einträge: der erste zählt', () => {
    const request = new Request('http://mac.local:4000/graphql', {
      headers: { 'x-forwarded-proto': 'https, http' },
    });
    expect(isSecureRequest(request)).toBe(true);
  });

  test('direkter https-Request ist sicher', () => {
    expect(isSecureRequest(new Request('https://mac.local/graphql'))).toBe(true);
  });

  test('reines LAN-http bleibt unsicher — sonst käme das Cookie nie an', () => {
    expect(isSecureRequest(new Request('http://192.168.1.77:4000/graphql'))).toBe(false);
  });

  test('ein gefälschter Forwarded-Header über http macht es nicht sicher', () => {
    const request = new Request('http://mac.local:4000/graphql', {
      headers: { 'x-forwarded-proto': 'http' },
    });
    expect(isSecureRequest(request)).toBe(false);
  });
});

/**
 * H2 / F10: Die Preview läuft auf demselben Host (nur anderer Port), und
 * Cookies sind nicht portgebunden. Agent-geschriebenes JS in der Preview kann
 * unser Session-Cookie zwar nicht überschreiben (httpOnly schützt davor) und
 * nicht lesen — aber es kann per `document.cookie` ein ZWEITES Cookie
 * gleichen Namens auf einem anderen Pfad setzen ("cookie tossing"). Der
 * Browser sendet dann beide, der spezifischere Pfad zuerst, und der Server
 * würde den untergeschobenen Token nehmen: Session-Fixation.
 */
describe('countSessionCookies (H2): untergeschobene Zweit-Cookies erkennen', () => {
  test('zählt ein einzelnes Session-Cookie', () => {
    expect(countSessionCookies('macvibes_session=abc')).toBe(1);
    expect(countSessionCookies('theme=dark; macvibes_session=abc; lang=de')).toBe(1);
  });

  test('zählt kein Cookie, wenn keins da ist', () => {
    expect(countSessionCookies(null)).toBe(0);
    expect(countSessionCookies('')).toBe(0);
    expect(countSessionCookies('theme=dark')).toBe(0);
  });

  test('erkennt das untergeschobene Zweit-Cookie (der Angriff)', () => {
    // So sieht es auf der Leitung aus, wenn die Preview
    // `document.cookie = 'macvibes_session=ANGREIFER; path=/graphql'` setzt.
    expect(countSessionCookies('macvibes_session=ANGREIFER; macvibes_session=echt')).toBe(2);
    expect(countSessionCookies('macvibes_session=a; theme=dark; macvibes_session=b')).toBe(2);
  });

  test('lässt sich nicht durch Namens-Teiltreffer täuschen', () => {
    expect(countSessionCookies('macvibes_session_alt=x; macvibes_session=echt')).toBe(1);
    expect(countSessionCookies('xmacvibes_session=x')).toBe(0);
  });

  test('verträgt Leerraum und leere Segmente', () => {
    expect(countSessionCookies('  macvibes_session=a  ;;  ')).toBe(1);
  });
});

describe('readSessionToken (H2): mehrdeutige Cookies gelten als nicht angemeldet', () => {
  function requestMit(cookie: string | null): Request {
    const init: RequestInit = cookie === null ? {} : { headers: { cookie } };
    const request = new Request('http://mac.local:4000/graphql', init);
    // Das useCookies-Plugin hängt den Store an; hier minimal nachgebildet.
    const store: CookieStoreLike = {
      get: async (name: string) => {
        const treffer = (cookie ?? '')
          .split(';')
          .map((teil) => teil.trim())
          .find((teil) => teil.startsWith(`${name}=`));
        return treffer === undefined ? undefined : { name, value: treffer.slice(name.length + 1) };
      },
      set: async () => {},
      delete: async () => {},
    };
    Object.defineProperty(request, 'cookieStore', { value: store, configurable: true });
    return request;
  }

  test('liest das Token, wenn es eindeutig ist', async () => {
    expect(await readSessionToken(requestMit('macvibes_session=abc'))).toBe('abc');
  });

  test('liefert null, wenn zwei Session-Cookies ankommen', async () => {
    // Lieber abmelden als den untergeschobenen Token akzeptieren.
    const token = await readSessionToken(
      requestMit('macvibes_session=ANGREIFER; macvibes_session=echt'),
    );
    expect(token).toBeNull();
  });

  test('liefert null ohne Cookie', async () => {
    expect(await readSessionToken(requestMit(null))).toBeNull();
  });
});
