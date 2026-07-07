import { describe, expect, test } from 'bun:test';
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
} from '../authService';
import { DomainError } from '../errors';
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
  test('befördert den konfigurierten User zu Admin + approved (idempotent)', async () => {
    const db = createTestDb();
    await register(db, CONFIG, registerInput('marco'));
    // gast als zweiter, pending
    const { user } = await register(db, CONFIG, registerInput('gast'));
    expect(user.role).toBe('user');

    await ensureAdmin(db, { ...CONFIG, adminUsername: 'gast' });
    const rows = await db.select().from(users).where(eq(users.id, user.id));
    expect(rows[0]?.role).toBe('admin');
    expect(rows[0]?.approved).toBe(true);

    // Zweiter Aufruf ändert nichts (kein Fehler).
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

    const before = await db.select().from(sessions).where(eq(sessions.id, token));
    const expiryBefore = before[0]?.expiresAt.getTime() ?? 0;

    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 1000) })
      .where(eq(sessions.id, token));

    const resolved = await resolveSession(db, CONFIG, token);
    expect(resolved?.id).toBe(user.id);

    const after = await db.select().from(sessions).where(eq(sessions.id, token));
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
      .where(eq(sessions.id, token));

    expect(await resolveSession(db, CONFIG, token)).toBeNull();
    const remaining = await db.select().from(sessions).where(eq(sessions.id, token));
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
