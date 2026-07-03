import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { sessions } from '../../db/schema';
import { login, logout, register, resolveSession } from '../authService';
import { DomainError } from '../errors';
import { createTestDb, TEST_AUTH_CONFIG } from './testUtils';

const CONFIG = TEST_AUTH_CONFIG;

describe('register', () => {
  test('legt User an und liefert Session', async () => {
    const db = createTestDb();
    const result = await register(db, CONFIG, {
      username: 'marco',
      password: 'passwort123',
      inviteCode: CONFIG.inviteCode,
    });
    expect(result.user.username).toBe('marco');
    expect(result.token.length).toBeGreaterThanOrEqual(64);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('lehnt falschen Invite-Code ab', async () => {
    const db = createTestDb();
    await expect(
      register(db, CONFIG, { username: 'marco', password: 'passwort123', inviteCode: 'falsch' }),
    ).rejects.toThrow('Ungültiger Invite-Code');
  });

  test('lehnt doppelten Benutzernamen ab', async () => {
    const db = createTestDb();
    const input = { username: 'marco', password: 'passwort123', inviteCode: CONFIG.inviteCode };
    await register(db, CONFIG, input);
    await expect(register(db, CONFIG, input)).rejects.toThrow('bereits vergeben');
  });

  test('validiert Username und Passwort', async () => {
    const db = createTestDb();
    await expect(
      register(db, CONFIG, {
        username: 'Ma',
        password: 'passwort123',
        inviteCode: CONFIG.inviteCode,
      }),
    ).rejects.toThrow(DomainError);
    await expect(
      register(db, CONFIG, { username: 'marco', password: 'kurz', inviteCode: CONFIG.inviteCode }),
    ).rejects.toThrow('mindestens 8 Zeichen');
  });
});

describe('login', () => {
  test('meldet mit korrektem Passwort an', async () => {
    const db = createTestDb();
    await register(db, CONFIG, {
      username: 'marco',
      password: 'passwort123',
      inviteCode: CONFIG.inviteCode,
    });
    const result = await login(db, CONFIG, 'marco', 'passwort123');
    expect(result.user.username).toBe('marco');
  });

  test('verrät nicht, ob der Benutzer existiert', async () => {
    const db = createTestDb();
    await register(db, CONFIG, {
      username: 'marco',
      password: 'passwort123',
      inviteCode: CONFIG.inviteCode,
    });
    await expect(login(db, CONFIG, 'marco', 'falsches-passwort')).rejects.toThrow(
      'Benutzername oder Passwort ist falsch',
    );
    await expect(login(db, CONFIG, 'niemand', 'passwort123')).rejects.toThrow(
      'Benutzername oder Passwort ist falsch',
    );
  });
});

describe('resolveSession', () => {
  test('löst gültige Session auf und verlängert rollierend', async () => {
    const db = createTestDb();
    const { user, token } = await register(db, CONFIG, {
      username: 'marco',
      password: 'passwort123',
      inviteCode: CONFIG.inviteCode,
    });

    const before = await db.select().from(sessions).where(eq(sessions.id, token));
    const expiryBefore = before[0]?.expiresAt.getTime() ?? 0;

    // Ablauf künstlich verkürzen, damit die Verlängerung messbar ist.
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
    const { token } = await register(db, CONFIG, {
      username: 'marco',
      password: 'passwort123',
      inviteCode: CONFIG.inviteCode,
    });
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
    const { token } = await register(db, CONFIG, {
      username: 'marco',
      password: 'passwort123',
      inviteCode: CONFIG.inviteCode,
    });
    await logout(db, token);
    expect(await resolveSession(db, CONFIG, token)).toBeNull();
  });
});
