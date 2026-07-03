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

export async function readSessionToken(request: Request): Promise<string | null> {
  const cookie = await cookieStoreOf(request).get(SESSION_COOKIE);
  return cookie?.value ?? null;
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
    // Kein HTTPS in v1 (lokales Netz) — secure-Cookies würden nie ankommen.
    secure: false,
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
    secure: false,
  });
}
