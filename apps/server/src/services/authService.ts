import { eq } from 'drizzle-orm';
import { passwordSchema, usernameSchema } from '@macvibes/shared';
import type { Db } from '../db/client';
import { sessions, users, type UserRow } from '../db/schema';
import { DomainError } from './errors';

const LOGIN_FAILED_MESSAGE = 'Benutzername oder Passwort ist falsch';

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RegisterInput {
  username: string;
  password: string;
  inviteCode: string;
}

export interface AuthConfig {
  inviteCode: string;
  sessionTtlMs: number;
}

export interface SessionResult {
  user: UserRow;
  token: string;
  expiresAt: Date;
}

export async function register(
  db: Db,
  config: AuthConfig,
  input: RegisterInput,
): Promise<SessionResult> {
  if (input.inviteCode !== config.inviteCode) {
    throw new DomainError('Ungültiger Invite-Code');
  }
  const usernameResult = usernameSchema.safeParse(input.username);
  if (!usernameResult.success) {
    throw new DomainError(usernameResult.error.issues[0]?.message ?? 'Ungültiger Benutzername');
  }
  const passwordResult = passwordSchema.safeParse(input.password);
  if (!passwordResult.success) {
    throw new DomainError(passwordResult.error.issues[0]?.message ?? 'Ungültiges Passwort');
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.username, usernameResult.data))
    .limit(1);
  if (existing.length > 0) {
    throw new DomainError('Benutzername ist bereits vergeben');
  }

  const passwordHash = await Bun.password.hash(passwordResult.data);
  const inserted = await db
    .insert(users)
    .values({ id: crypto.randomUUID(), username: usernameResult.data, passwordHash })
    .returning();
  const user = inserted[0];
  if (!user) {
    throw new Error('User-Insert lieferte keine Zeile zurück');
  }
  return createSession(db, config, user);
}

export async function login(
  db: Db,
  config: AuthConfig,
  username: string,
  password: string,
): Promise<SessionResult> {
  const found = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const user = found[0];
  if (!user) {
    throw new DomainError(LOGIN_FAILED_MESSAGE);
  }
  const valid = await Bun.password.verify(password, user.passwordHash);
  if (!valid) {
    throw new DomainError(LOGIN_FAILED_MESSAGE);
  }
  return createSession(db, config, user);
}

async function createSession(db: Db, config: AuthConfig, user: UserRow): Promise<SessionResult> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  await db.insert(sessions).values({ id: token, userId: user.id, expiresAt });
  return { user, token, expiresAt };
}

/**
 * Löst einen Session-Token auf und verlängert die Session rollierend.
 * Abgelaufene Sessions werden gelöscht und liefern null.
 */
export async function resolveSession(
  db: Db,
  config: AuthConfig,
  token: string,
): Promise<UserRow | null> {
  const found = await db.select().from(sessions).where(eq(sessions.id, token)).limit(1);
  const session = found[0];
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, token));
    return null;
  }

  const newExpiry = new Date(Date.now() + config.sessionTtlMs);
  await db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, token));

  const userFound = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  return userFound[0] ?? null;
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, token));
}
