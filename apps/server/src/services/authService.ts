import { createHash } from 'node:crypto';
import { desc, eq, lt } from 'drizzle-orm';
import { passwordSchema, usernameSchema } from '@macvibes/shared';
import type { Db } from '../db/client';
import { sessions, users, type UserRow } from '../db/schema';
import { DomainError } from './errors';

const LOGIN_FAILED_MESSAGE = 'Benutzername oder Passwort ist falsch';
const NOT_APPROVED_MESSAGE =
  'Dein Konto ist noch nicht freigeschaltet — ein Admin muss dich zulassen.';

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RegisterInput {
  username: string;
  password: string;
}

export interface AuthConfig {
  sessionTtlMs: number;
  /** Optionaler Bootstrap-Admin: dieser Username wird beim Start zum Admin. */
  adminUsername?: string | undefined;
}

export interface Session {
  token: string;
  expiresAt: Date;
}

/** Ergebnis einer Selbst-Registrierung: Session nur, wenn direkt freigeschaltet. */
export interface RegisterResult {
  user: UserRow;
  session: Session | null;
}

export interface SessionResult {
  user: UserRow;
  token: string;
  expiresAt: Date;
}

/**
 * Selbst-Registrierung (kein Invite-Code mehr). Der allererste Nutzer wird
 * automatisch Admin und ist sofort freigeschaltet (+ eingeloggt). Jeder weitere
 * Nutzer ist zunächst `pending` (nicht freigeschaltet, keine Session) und muss
 * von einem Admin zugelassen werden, bevor ein Login möglich ist.
 */
export async function register(
  db: Db,
  config: AuthConfig,
  input: RegisterInput,
): Promise<RegisterResult> {
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

  // F8: Admin NICHT mehr aus der Registrierungsreihenfolge ableiten.
  // Bisher wurde der erste Registrant Admin — bei frischem Deployment,
  // DB-Reset oder neuem DB_PATH konnte das ein Fremder sein, und weil
  // Emptiness-Check und Insert durch das await auf argon2 getrennt sind,
  // ergaben zwei parallele Registrierungen sogar zwei Admins.
  // Der Erst-Admin wird jetzt nur, wer den konfigurierten Bootstrap-Namen
  // trägt (MACVIBES_ADMIN_USERNAME); ohne Konfiguration bleibt der erste
  // Nutzer aus Bequemlichkeit Admin, aber nur wenn wirklich noch keiner da
  // ist — geprüft in derselben Transaktion wie der Insert.
  const passwordHash = await Bun.password.hash(passwordResult.data);
  const bootstrapName = config.adminUsername ?? null;
  // bun:sqlite ist synchron — Prüfung und Insert laufen ohne await dazwischen,
  // also atomar gegenüber parallelen Registrierungen.
  const inserted = db.transaction((tx) => {
    const admins = tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).all();
    // Ohne konfigurierten Bootstrap-Namen wird NIEMAND automatisch Admin (H3).
    // Vorher bekam der erste Registrant die Rolle „aus Bequemlichkeit" — weil
    // register() unauthentifiziert ist und der Server im LAN lauscht, war das
    // ein Wettlauf um Admin-Rechte, den jeder im Netz gewinnen konnte. Der
    // Betreiber muss den Admin jetzt benennen (MACVIBES_ADMIN_USERNAME).
    const istErsterAdmin =
      admins.length === 0 && bootstrapName !== null && usernameResult.data === bootstrapName;
    return tx
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        username: usernameResult.data,
        passwordHash,
        role: istErsterAdmin ? 'admin' : 'user',
        approved: istErsterAdmin,
      })
      .returning()
      .all();
  });
  const user = inserted[0];
  if (!user) {
    throw new Error('User-Insert lieferte keine Zeile zurück');
  }

  if (!user.approved) {
    return { user, session: null };
  }
  const session = await createSession(db, config, user);
  return { user, session };
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
  if (!user.approved) {
    throw new DomainError(NOT_APPROVED_MESSAGE);
  }
  const session = await createSession(db, config, user);
  return { user, token: session.token, expiresAt: session.expiresAt };
}

/**
 * Speicher-Schlüssel einer Session. Der Klartext-Token verlässt den Prozess
 * nur im Cookie; in der DB steht sein SHA-256. Wer die Datei liest, bekommt
 * damit keine übernehmbaren Sitzungen mehr — und der Vergleich bleibt ein
 * einfacher Primärschlüssel-Lookup.
 */
export function sessionKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function createSession(db: Db, config: AuthConfig, user: UserRow): Promise<Session> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);
  await db.insert(sessions).values({ id: sessionKey(token), userId: user.id, expiresAt });
  return { token, expiresAt };
}

/**
 * Räumt abgelaufene Sessions weg. Bisher wurde eine Zeile nur gelöscht, wenn
 * jemand mit genau diesem Token wiederkam — was bei abgelaufenen Cookies nie
 * passiert; entsprechend sammelten sie sich an.
 */
export async function purgeExpiredSessions(db: Db): Promise<number> {
  const removed = await db.delete(sessions).where(lt(sessions.expiresAt, new Date())).returning();
  return removed.length;
}

/** Alle Nutzer, neueste zuerst — für das Admin-Panel. */
export async function listUsers(db: Db): Promise<UserRow[]> {
  return db.select().from(users).orderBy(desc(users.createdAt));
}

/** Schaltet einen Nutzer frei (Admin-Aktion). */
export async function approveUser(db: Db, userId: string): Promise<UserRow> {
  const updated = await db
    .update(users)
    .set({ approved: true })
    .where(eq(users.id, userId))
    .returning();
  const user = updated[0];
  if (!user) {
    throw new DomainError('Nutzer nicht gefunden');
  }
  return user;
}

/**
 * Lehnt eine Registrierung ab und entfernt den Nutzer (samt Sessions).
 * Ein Admin kann nicht entfernt werden.
 */
export async function rejectUser(db: Db, userId: string): Promise<void> {
  const found = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = found[0];
  if (!user) {
    throw new DomainError('Nutzer nicht gefunden');
  }
  if (user.role === 'admin') {
    throw new DomainError('Ein Admin kann nicht entfernt werden');
  }
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

/**
 * Bootstrap beim Serverstart: der per Config gesetzte `adminUsername` wird — falls
 * vorhanden — zum Admin befördert und freigeschaltet. Idempotent; ohne Config-Wert
 * passiert nichts. Ergänzt die einmalige Migration und erlaubt es, den Admin per
 * Env festzunageln (auch nach einem Reset).
 */
export async function ensureAdmin(db: Db, config: AuthConfig): Promise<void> {
  const username = config.adminUsername;
  if (!username) {
    // H3: Ohne Bootstrap-Namen vergibt register() keine Admin-Rolle mehr. Das
    // darf den Betreiber nicht ratlos lassen — ohne Admin schaltet niemand
    // Nutzer frei, die Instanz wäre also unbenutzbar ohne erkennbaren Grund.
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
    if (admins.length === 0) {
      console.warn(
        'Kein Admin vorhanden und MACVIBES_ADMIN_USERNAME ist nicht gesetzt. ' +
          'Ohne Admin kann niemand neue Nutzer freischalten. ' +
          'Setze MACVIBES_ADMIN_USERNAME=<dein-username> in apps/server/.env und ' +
          'starte neu (registriere den Namen davor oder danach — die Beförderung ' +
          'passiert beim Start).',
      );
    }
    return;
  }
  const found = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const user = found[0];
  if (!user) return;
  if (user.role === 'admin' && user.approved) return;

  // F21: Beförderung nur als echter Bootstrap — solange KEIN Admin existiert.
  // Vorher wurde bei jedem Start befördert, wer gerade den konfigurierten
  // Namen trug; da register den Namen nicht reserviert und .env.example ihn
  // verrät, konnte ein Fremder ihn vorbelegen und wurde beim nächsten
  // Neustart Admin.
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
  const erzwungen = Bun.env.MACVIBES_FORCE_ADMIN === '1' || Bun.env.MACVIBES_FORCE_ADMIN === 'true';
  if (admins.length > 0 && !erzwungen) {
    console.warn(
      `Bootstrap-Admin "${username}" wird NICHT befördert — es gibt bereits einen Admin. ` +
        'Zum Erzwingen MACVIBES_FORCE_ADMIN=1 setzen.',
    );
    return;
  }
  await db.update(users).set({ role: 'admin', approved: true }).where(eq(users.id, user.id));
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
  const key = sessionKey(token);
  const found = await db.select().from(sessions).where(eq(sessions.id, key)).limit(1);
  const session = found[0];
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, key));
    return null;
  }

  const newExpiry = new Date(Date.now() + config.sessionTtlMs);
  await db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, key));

  const userFound = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  const user = userFound[0];
  if (!user) return null;
  // Ein zurückgezogenes Approval muss bestehende Sessions kappen — sonst
  // arbeitet ein abgelehnter Nutzer bis zum TTL-Ende weiter.
  if (!user.approved) {
    await db.delete(sessions).where(eq(sessions.id, key));
    return null;
  }
  return user;
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionKey(token)));
}
