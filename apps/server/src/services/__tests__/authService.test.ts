import { describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { sessions, users } from '../../db/schema';
import {
  approveUser,
  ensureAdmin,
  listUsers,
  login,
  logout,
  register,
  rejectUser,
  resolveSession,
  purgeExpiredSessions,
  sessionKey,
} from '../authService';
import { DomainError } from '../../core/errors';
import { createTestDb, TEST_AUTH_CONFIG } from './testUtils';

const CONFIG = TEST_AUTH_CONFIG;

function registerInput(username = 'marco', password = 'passwort123') {
  return { username, password };
}

describe('register (Self-Registration)', () => {
  test('erster User wird Admin, ist freigeschaltet und sofort eingeloggt', async () => {
    const db = createTestDb();
    const result = await register(db, CONFIG, registerInput());
    expect(result.user.username).toBe('marco');
    expect(result.user.role).toBe('admin');
    expect(result.user.approved).toBe(true);
    expect(result.session).not.toBeNull();
    expect(result.session?.token.length).toBeGreaterThanOrEqual(64);
    expect(result.session?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('weitere User sind pending: nicht freigeschaltet, keine Session', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput('marco'));
    const second = await register(db, CONFIG, registerInput('gast'));
    expect(second.user.role).toBe('user');
    expect(second.user.approved).toBe(false);
    expect(second.session).toBeNull();
  });

  test('braucht keinen Invite-Code mehr', async () => {
    const db = createTestDb();
    // Kein inviteCode im Input — muss trotzdem durchgehen.
    const result = await register(db, CONFIG, registerInput());
    expect(result.user.id).toBeTruthy();
  });

  test('lehnt doppelten Benutzernamen ab', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput());
    await expect(register(db, CONFIG, registerInput())).rejects.toThrow('bereits vergeben');
  });

  test('validiert Username und Passwort', async () => {
    const db = createTestDb();
    await expect(register(db, CONFIG, registerInput('Ma'))).rejects.toThrow(DomainError);
    await expect(register(db, CONFIG, registerInput('marco', 'kurz'))).rejects.toThrow(
      'mindestens 8 Zeichen',
    );
  });
});

describe('login', () => {
  test('freigeschalteter User meldet sich an', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput()); // erster User = Admin, approved
    const result = await login(db, CONFIG, 'marco', 'passwort123');
    expect(result.user.username).toBe('marco');
  });

  test('nicht freigeschalteter User wird abgewiesen (Passwort korrekt)', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput('marco'));
    await register(db, CONFIG, registerInput('gast', 'gast-passwort'));
    await expect(login(db, CONFIG, 'gast', 'gast-passwort')).rejects.toThrow(
      'noch nicht freigeschaltet',
    );
  });

  test('verrät nicht, ob der Benutzer existiert', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput());
    await expect(login(db, CONFIG, 'marco', 'falsches-passwort')).rejects.toThrow(
      'Benutzername oder Passwort ist falsch',
    );
    await expect(login(db, CONFIG, 'niemand', 'passwort123')).rejects.toThrow(
      'Benutzername oder Passwort ist falsch',
    );
  });
});

describe('Admin-Freischaltung', () => {
  test('approveUser schaltet frei — danach klappt der Login', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput('marco'));
    const { user } = await register(db, CONFIG, registerInput('gast', 'gast-passwort'));
    expect(user.approved).toBe(false);

    const approved = await approveUser(db, user.id);
    expect(approved.approved).toBe(true);

    const result = await login(db, CONFIG, 'gast', 'gast-passwort');
    expect(result.user.username).toBe('gast');
  });

  test('rejectUser entfernt die Registrierung — Login nicht mehr möglich', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput('marco'));
    const { user } = await register(db, CONFIG, registerInput('spam', 'spam-passwort'));
    await rejectUser(db, user.id);

    const remaining = await db.select().from(users).where(eq(users.id, user.id));
    expect(remaining).toHaveLength(0);
    await expect(login(db, CONFIG, 'spam', 'spam-passwort')).rejects.toThrow(
      'Benutzername oder Passwort ist falsch',
    );
  });

  test('rejectUser verweigert das Löschen eines Admins', async () => {
    const db = createTestDb();
    const { user: admin } = await register(db, CONFIG, registerInput('marco'));
    await expect(rejectUser(db, admin.id)).rejects.toThrow(DomainError);
  });

  test('listUsers liefert alle User mit Status, neueste zuerst', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput('marco'));
    await register(db, CONFIG, registerInput('gast'));
    const all = await listUsers(db);
    expect(all.map((u) => u.username).sort()).toEqual(['gast', 'marco']);
    const admin = all.find((u) => u.username === 'marco');
    const gast = all.find((u) => u.username === 'gast');
    expect(admin?.role).toBe('admin');
    expect(gast?.approved).toBe(false);
  });
});

describe('ensureAdmin (Bootstrap)', () => {
  /**
   * F21: ensureAdmin beförderte bei JEDEM Start, wer gerade den konfigurierten
   * Namen trug — ohne zu prüfen, wer die Zeile wann angelegt hat. Da register
   * unauthentifiziert ist und den Namen nicht reserviert (und .env.example ihn
   * verrät), konnte ein Fremder ihn vorbelegen und wurde beim nächsten
   * Neustart Admin.
   */
  test('befördert NICHT, wenn bereits ein Admin existiert (F21)', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput('marco')); // wird Erst-Admin
    const { user } = await register(db, CONFIG, registerInput('gast'));
    expect(user.role).toBe('user');

    await ensureAdmin(db, { ...CONFIG, adminUsername: 'gast' });

    const rows = await db.select().from(users).where(eq(users.id, user.id));
    expect(rows[0]?.role).toBe('user');
    expect(rows[0]?.approved).toBe(false);
  });

  test('echter Bootstrap: befördert, solange es keinen Admin gibt', async () => {
    const db = createTestDb();
    // Registrierung mit gesetztem Bootstrap-Namen: ein anderer Name wird
    // NICHT automatisch Admin (F8).
    const { user } = await register(
      db,
      { ...CONFIG, adminUsername: 'chefin' },
      registerInput('gast'),
    );
    expect(user.role).toBe('user');

    await ensureAdmin(db, { ...CONFIG, adminUsername: 'gast' });

    const rows = await db.select().from(users).where(eq(users.id, user.id));
    expect(rows[0]?.role).toBe('admin');
    expect(rows[0]?.approved).toBe(true);

    // Idempotent: zweiter Aufruf ändert nichts und wirft nicht.
    await ensureAdmin(db, { ...CONFIG, adminUsername: 'gast' });
    const again = await db.select().from(users).where(eq(users.id, user.id));
    expect(again[0]?.role).toBe('admin');
  });

  test('ohne adminUsername passiert nichts', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput('marco'));
    await ensureAdmin(db, { ...CONFIG, adminUsername: undefined });
    // marco bleibt der Admin (erster User), gast gäbe es nicht.
    const all = await listUsers(db);
    expect(all).toHaveLength(1);
  });
});

describe('resolveSession', () => {
  test('löst gültige Session auf und verlängert rollierend', async () => {
    const db = createTestDb();
    const { user, session } = await register(db, CONFIG, registerInput());
    const token = session!.token;

    const before = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionKey(token)));
    const expiryBefore = before[0]?.expiresAt.getTime() ?? 0;

    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 1000) })
      .where(eq(sessions.id, sessionKey(token)));

    const resolved = await resolveSession(db, CONFIG, token);
    expect(resolved?.id).toBe(user.id);

    const after = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionKey(token)));
    const expiryAfter = after[0]?.expiresAt.getTime() ?? 0;
    expect(expiryAfter).toBeGreaterThan(Date.now() + 1000);
    expect(expiryBefore).toBeGreaterThan(0);
  });

  test('löscht abgelaufene Session und liefert null', async () => {
    const db = createTestDb();
    const { session } = await register(db, CONFIG, registerInput());
    const token = session!.token;
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, sessionKey(token)));

    expect(await resolveSession(db, CONFIG, token)).toBeNull();
    const remaining = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionKey(token)));
    expect(remaining).toHaveLength(0);
  });

  test('liefert null für unbekannten Token', async () => {
    const db = createTestDb();
    expect(await resolveSession(db, CONFIG, 'gibt-es-nicht')).toBeNull();
  });
});

describe('logout', () => {
  test('invalidiert die Session serverseitig', async () => {
    const db = createTestDb();
    const { session } = await register(db, CONFIG, registerInput());
    const token = session!.token;
    await logout(db, token);
    expect(await resolveSession(db, CONFIG, token)).toBeNull();
  });
});

/**
 * F8: Der erste Registrant wurde Admin — bei frischem Deployment, DB-Reset
 * oder neuem DB_PATH konnte das ein Fremder sein. Ist ein Bootstrap-Name
 * konfiguriert, bekommt nur er die Rolle.
 */
describe('Erst-Admin-Vergabe (F8, H3)', () => {
  // Ausdrücklich OHNE Bootstrap-Namen — das ist der Default im Betrieb.
  const OHNE_BOOTSTRAP = { ...CONFIG, adminUsername: undefined };

  test('ohne Bootstrap-Namen wird NIEMAND Admin (H3: fail closed)', async () => {
    // Vorher wurde der erste Registrant aus Bequemlichkeit Admin. Weil
    // register() unauthentifiziert ist und der Server im LAN lauscht, war das
    // ein Wettlauf um Admin-Rechte, den jeder im Netz gewinnen konnte.
    const db = createTestDb();
    const { user, session } = await register(db, OHNE_BOOTSTRAP, registerInput('marco'));
    expect(user.role).toBe('user');
    expect(user.approved).toBe(false);
    expect(session).toBeNull();
  });

  test('auch der zweite und dritte Nutzer bekommen ohne Bootstrap-Namen nichts', async () => {
    const db = createTestDb();
    await register(db, OHNE_BOOTSTRAP, registerInput('eins'));
    const { user } = await register(db, OHNE_BOOTSTRAP, registerInput('zwei'));
    expect(user.role).toBe('user');
    const admins = await db.select().from(users).where(eq(users.role, 'admin'));
    expect(admins.length).toBe(0);
  });

  test('mit Bootstrap-Namen wird ein FREMDER Erstregistrant kein Admin', async () => {
    const db = createTestDb();
    const config = { ...CONFIG, adminUsername: 'marco' };
    const { user } = await register(db, config, registerInput('fremder'));
    expect(user.role).toBe('user');
    expect(user.approved).toBe(false);
  });

  test('mit Bootstrap-Namen wird genau dieser Nutzer Admin', async () => {
    const db = createTestDb();
    const config = { ...CONFIG, adminUsername: 'marco' };
    const { user } = await register(db, config, registerInput('marco'));
    expect(user.role).toBe('admin');
  });

  test('es entsteht nie ein zweiter Admin, auch bei paralleler Registrierung', async () => {
    const db = createTestDb();
    const config = { ...CONFIG, adminUsername: 'eins' };
    await Promise.all([
      register(db, config, registerInput('eins')),
      register(db, config, registerInput('zwei')),
      register(db, config, registerInput('drei')),
    ]);
    const admins = await db.select().from(users).where(eq(users.role, 'admin'));
    expect(admins.length).toBe(1);
  });

  test('ein bereits vorhandener Admin verhindert weitere Bootstraps', async () => {
    const db = createTestDb();
    const config = { ...CONFIG, adminUsername: 'chefin' };
    const { user: chefin } = await register(db, config, registerInput('chefin'));
    expect(chefin.role).toBe('admin');
    // Selber Bootstrap-Name, aber es gibt schon einen Admin: kein zweiter.
    const { user: zweite } = await register(db, config, registerInput('chefin2'));
    expect(zweite.role).toBe('user');
  });
});

/**
 * Bootstrap-Token (MACVIBES_ADMIN_BOOTSTRAP_TOKEN): Ohne Token wird auf einer
 * frischen Instanz (Erstinstallation, DB-Reset, neuer DB_PATH) derjenige Admin,
 * der sich ZUERST mit dem Bootstrap-Namen registriert — der Server lauscht im
 * LAN, und .env.example verriet den Namen auch noch. Ist der Token gesetzt, ist
 * der Name RESERVIERT: Registrierung nur mit dem Out-of-Band-Secret.
 */
describe('Erst-Admin nur mit Bootstrap-Token (MACVIBES_ADMIN_BOOTSTRAP_TOKEN)', () => {
  const TOKEN = 'f00ba5f00ba5f00ba5f00ba5f00ba5f00ba5f00ba5f00ba5';
  const MIT_TOKEN = { ...CONFIG, adminUsername: 'marco', adminBootstrapToken: TOKEN };

  test('Bootstrap-Name OHNE Token: wirft, KEIN User angelegt, kein Admin', async () => {
    const db = createTestDb();
    await expect(register(db, MIT_TOKEN, registerInput('marco'))).rejects.toThrow('reserviert');
    // Der Name bleibt frei — ein Fremder kann ihn nicht durch den Fehlversuch
    // belegen und den echten Betreiber aussperren.
    expect(await db.select().from(users)).toHaveLength(0);
  });

  test('Bootstrap-Name mit FALSCHEM Token: wirft, kein User, kein Admin', async () => {
    const db = createTestDb();
    await expect(
      register(db, MIT_TOKEN, { ...registerInput('marco'), bootstrapToken: 'falsches-secret' }),
    ).rejects.toThrow('reserviert');
    expect(await db.select().from(users)).toHaveLength(0);
  });

  test('die Fehlermeldung verrät den Token NICHT', async () => {
    const db = createTestDb();
    let meldung = '';
    try {
      await register(db, MIT_TOKEN, { ...registerInput('marco'), bootstrapToken: 'falsch' });
    } catch (error) {
      meldung = (error as Error).message;
    }
    expect(meldung.length).toBeGreaterThan(0);
    expect(meldung).not.toContain(TOKEN);
  });

  test('mit KORREKTEM Token und ohne existierenden Admin: Admin + approved + Session', async () => {
    const db = createTestDb();
    const { user, session } = await register(db, MIT_TOKEN, {
      ...registerInput('marco'),
      bootstrapToken: TOKEN,
    });
    expect(user.role).toBe('admin');
    expect(user.approved).toBe(true);
    expect(session).not.toBeNull();
  });

  test('korrekter Token, aber es EXISTIERT schon ein Admin: kein Verdrängen', async () => {
    const db = createTestDb();
    // Anderer Admin bereits vorhanden (per Start-Bootstrap befördert).
    await register(db, MIT_TOKEN, registerInput('chefin'));
    await ensureAdmin(db, { ...CONFIG, adminUsername: 'chefin' });

    const { user, session } = await register(db, MIT_TOKEN, {
      ...registerInput('marco'),
      bootstrapToken: TOKEN,
    });
    expect(user.role).toBe('user');
    expect(user.approved).toBe(false);
    expect(session).toBeNull();
  });

  test('ein ANDERER Username ist vom Token unberührt (registriert normal, pending)', async () => {
    const db = createTestDb();
    const { user } = await register(db, MIT_TOKEN, registerInput('gast'));
    expect(user.role).toBe('user');
    expect(user.approved).toBe(false);
  });

  test('OHNE gesetzten Token gilt das Alt-Verhalten (Rückwärtskompatibilität)', async () => {
    // Bestehende Installationen (Admin existiert längst) laufen unverändert:
    // CONFIG hat keinen adminBootstrapToken — der Bootstrap-Name wird wie
    // bisher ohne Token Admin. Die übrigen Suiten dieses Files belegen den
    // Rest des Alt-Verhaltens.
    const db = createTestDb();
    const { user } = await register(db, CONFIG, registerInput('marco'));
    expect(user.role).toBe('admin');
    expect(user.approved).toBe(true);
  });
});

/**
 * Serverstart-Warnung: Ist ein Bootstrap-Name gesetzt, aber KEIN Token und
 * noch KEIN Admin vorhanden, kann jeder im Netz den Namen beanspruchen —
 * das muss der Betreiber beim Start deutlich sehen.
 */
describe('ensureAdmin warnt vor ungeschütztem Bootstrap-Namen', () => {
  test('kein Admin + Bootstrap-Name gesetzt + kein Token: deutliche Warnung', async () => {
    const db = createTestDb();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ensureAdmin(db, { ...CONFIG, adminUsername: 'marco' });
      const gesamt = warnSpy.mock.calls.flat().join(' ');
      expect(gesamt).toContain('MACVIBES_ADMIN_BOOTSTRAP_TOKEN');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('mit gesetztem Token: keine Warnung', async () => {
    const db = createTestDb();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ensureAdmin(db, {
        ...CONFIG,
        adminUsername: 'marco',
        adminBootstrapToken: 'ein-secret',
      });
      const gesamt = warnSpy.mock.calls.flat().join(' ');
      expect(gesamt).not.toContain('MACVIBES_ADMIN_BOOTSTRAP_TOKEN');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('mit existierendem Admin: keine Warnung (der Bootstrap-Pfad greift nicht mehr)', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput('marco')); // wird Admin
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await ensureAdmin(db, { ...CONFIG, adminUsername: 'marco' });
      const gesamt = warnSpy.mock.calls.flat().join(' ');
      expect(gesamt).not.toContain('MACVIBES_ADMIN_BOOTSTRAP_TOKEN');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * Benutzer-Enumeration über die Login-Laufzeit: Bei unbekanntem Nutzer kehrte
 * login() VOR dem argon2-Verify zurück — die An-/Abwesenheit der teuren
 * Operation war über das LAN messbar. Jetzt läuft in BEIDEN Fällen genau ein
 * Verify (bei unbekanntem Nutzer gegen einen festen Dummy-Hash).
 */
describe('login: konstante Arbeit gegen Benutzer-Enumeration', () => {
  test('unbekannter Nutzer und falsches Passwort: selbe Meldung, je genau EIN Verify', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput());
    const verifySpy = spyOn(Bun.password, 'verify');
    try {
      await expect(login(db, CONFIG, 'niemand', 'passwort123')).rejects.toThrow(
        'Benutzername oder Passwort ist falsch',
      );
      // Deterministischer Beleg statt flakiger Zeitschranke: auch der
      // unbekannte Nutzer kostet einen vollen argon2-Verify.
      expect(verifySpy).toHaveBeenCalledTimes(1);

      await expect(login(db, CONFIG, 'marco', 'falsches-passwort')).rejects.toThrow(
        'Benutzername oder Passwort ist falsch',
      );
      expect(verifySpy).toHaveBeenCalledTimes(2);
    } finally {
      verifySpy.mockRestore();
    }
  });
});

/**
 * Zusatz zu AP7: Der Klartext-Token ist zugleich Cookie-Wert. Lag er im
 * Primärschlüssel, war jeder Lesezugriff auf die DB-Datei gleichbedeutend mit
 * übernehmbaren Sitzungen.
 */
describe('Session-Token wird gehasht gespeichert', () => {
  test('der Cookie-Wert steht nicht in der Datenbank', async () => {
    const db = createTestDb();
    const { session } = await register(db, CONFIG, registerInput());
    const token = session!.token;

    const alle = await db.select().from(sessions);
    expect(alle.map((s) => s.id)).not.toContain(token);
    expect(alle[0]?.id).toBe(sessionKey(token));
  });

  test('die Auflösung funktioniert trotzdem mit dem Klartext-Token', async () => {
    const db = createTestDb();
    const { user, session } = await register(db, CONFIG, registerInput());
    const resolved = await resolveSession(db, CONFIG, session!.token);
    expect(resolved?.id).toBe(user.id);
  });

  test('purgeExpiredSessions räumt abgelaufene Zeilen weg', async () => {
    const db = createTestDb();
    const { session } = await register(db, CONFIG, registerInput());
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, sessionKey(session!.token)));

    const entfernt = await purgeExpiredSessions(db);

    expect(entfernt).toBe(1);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });
});

/**
 * resolveSession schrieb die neue Ablaufzeit bei JEDEM authentifizierten
 * Request in die Datenbank — ohne jede Schwelle. Bei einem Sekundenpoll des
 * Frontends sind das dutzende Schreibvorgänge pro Minute und Nutzer auf
 * derselben Zeile; unter bun:sqlite konkurrieren die mit jedem anderen
 * Schreiber. Rollierende Verlängerung braucht das nicht: es genügt, sie
 * nachzuziehen, wenn ein nennenswerter Teil der Frist verstrichen ist.
 */
describe('resolveSession: rollierende Verlängerung mit Schwelle', () => {
  async function ablauf(db: ReturnType<typeof createTestDb>, token: string): Promise<number> {
    const zeile = (
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionKey(token)))
        .limit(1)
    )[0];
    if (!zeile) throw new Error('Session nicht gefunden');
    return zeile.expiresAt.getTime();
  }

  test('schreibt NICHT, solange der grösste Teil der Frist übrig ist', async () => {
    const db = createTestDb();
    const { session } = await register(db, CONFIG, registerInput());
    const token = session!.token;

    // Schreibvorgänge zählen statt Zeitstempel vergleichen: SQLite legt die
    // Zeit sekundengenau ab, ein Unterschied von Millisekunden ginge unter.
    let schreibvorgaenge = 0;
    const zaehlendeDb = new Proxy(db, {
      get(ziel, eigenschaft, empfaenger): unknown {
        if (eigenschaft === 'update') schreibvorgaenge += 1;
        return Reflect.get(ziel, eigenschaft, empfaenger);
      },
    }) as typeof db;

    expect(await resolveSession(zaehlendeDb, CONFIG, token)).not.toBeNull();

    expect(schreibvorgaenge).toBe(0);
  });

  test('verlängert, sobald weniger als die Hälfte der Frist übrig ist', async () => {
    const db = createTestDb();
    const { session } = await register(db, CONFIG, registerInput());
    const token = session!.token;
    // Session künstlich altern lassen: nur noch 40 % der Frist übrig.
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + Math.floor(CONFIG.sessionTtlMs * 0.4)) })
      .where(eq(sessions.id, sessionKey(token)));
    const vorher = await ablauf(db, token);

    expect(await resolveSession(db, CONFIG, token)).not.toBeNull();

    expect(await ablauf(db, token)).toBeGreaterThan(vorher);
  });
});
