import { createHash, timingSafeEqual } from 'node:crypto';
import { desc, eq, lt } from 'drizzle-orm';
import { passwordSchema, usernameSchema } from '@macvibes/shared';
import type { Db } from '../db/client';
import { sessions, users, type UserRow } from '../db/schema';
import { DomainError } from '../core/errors';

const LOGIN_FAILED_MESSAGE = 'Benutzername oder Passwort ist falsch';
const NOT_APPROVED_MESSAGE =
  'Dein Konto ist noch nicht freigeschaltet — ein Admin muss dich zulassen.';
// Bewusst OHNE den Token oder sonstige Details — die Meldung geht an einen
// unauthentifizierten Aufrufer.
const BOOTSTRAP_RESERVED_MESSAGE =
  'Dieser Benutzername ist für den Bootstrap-Admin reserviert. Die Registrierung ' +
  'verlangt das Bootstrap-Token aus der Server-Konfiguration (MACVIBES_ADMIN_BOOTSTRAP_TOKEN).';

/**
 * Fester argon2-Hash für Logins mit UNBEKANNTEM Benutzernamen (Timing-Oracle):
 * Vorher kehrte login() bei unbekanntem Nutzer VOR dem argon2-Verify zurück —
 * die An-/Abwesenheit der teuren Operation (~100 ms) war über das LAN messbar
 * und verriet, welche Benutzernamen existieren. Der Hash ist EINMAL
 * vorberechnet (Bun.password.hash eines fixen Strings, Bun-1.3.14-Default
 * argon2id): pro Request neu hashen würde die Laufzeit erneut vom bekannten
 * Fall unterscheiden. Das Verify-Ergebnis wird verworfen — es zählt nur die
 * konstante Arbeit.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$nRXZwqmzCBc/j2YqH5HY1xz0gFYgWk3x6orJ2W/zEds$5VFwEI7rq0Kb7ZTVAp45NhYpXwD6LY3WjBD1RTCyVGU';

/**
 * Timing-safer Vergleich des Bootstrap-Tokens — dasselbe Muster wie
 * core/vmTokens.lookup: beide Seiten SHA-256-hashen (normalisiert die Länge,
 * timingSafeEqual verlangt gleich lange Buffer), dann konstantzeitig
 * vergleichen. Ein naiver `===` verriete über die Laufzeit Länge und
 * Präfix des richtigen Tokens.
 */
function bootstrapTokenGueltig(eingereicht: string, erwartet: string): boolean {
  const a = createHash('sha256').update(eingereicht).digest();
  const b = createHash('sha256').update(erwartet).digest();
  return timingSafeEqual(a, b);
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RegisterInput {
  username: string;
  password: string;
  /**
   * Out-of-Band-Secret für die Erst-Registrierung des Bootstrap-Admins —
   * nur nötig, wenn MACVIBES_ADMIN_BOOTSTRAP_TOKEN gesetzt ist und der
   * Username der Bootstrap-Name ist. Für alle anderen Nutzer irrelevant.
   */
  bootstrapToken?: string | null | undefined;
}

export interface AuthConfig {
  sessionTtlMs: number;
  /** Optionaler Bootstrap-Admin: dieser Username wird beim Start zum Admin. */
  adminUsername?: string | undefined;
  /**
   * MACVIBES_FORCE_ADMIN (via config.ts, M6): befördert den Bootstrap-Admin
   * auch, wenn bereits ein Admin existiert (F21).
   */
  forceAdmin?: boolean | undefined;
  /**
   * MACVIBES_ADMIN_BOOTSTRAP_TOKEN (via config.ts, M6): gesetzt ⇒ der
   * Bootstrap-Name ist reserviert und register() verlangt genau dieses
   * Token; null/undefined ⇒ Alt-Verhalten (bestehende Installationen).
   */
  adminBootstrapToken?: string | null | undefined;
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
 * Selbst-Registrierung (kein Invite-Code mehr). Nur der konfigurierte
 * Bootstrap-Name (MACVIBES_ADMIN_USERNAME) wird — solange kein Admin
 * existiert — Admin und ist sofort freigeschaltet (+ eingeloggt); mit
 * gesetztem MACVIBES_ADMIN_BOOTSTRAP_TOKEN nur gegen Vorlage dieses Tokens.
 * Jeder andere Nutzer ist zunächst `pending` (nicht freigeschaltet, keine
 * Session) und muss von einem Admin zugelassen werden, bevor ein Login
 * möglich ist.
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

  // Bootstrap-Schutz VOR jedem Insert: Ist MACVIBES_ADMIN_BOOTSTRAP_TOKEN
  // gesetzt, ist der Bootstrap-Name RESERVIERT — eine Registrierung mit diesem
  // Namen verlangt das Out-of-Band-Secret. Ohne diesen Riegel könnte auf einer
  // frischen Instanz (Erstinstallation, DB-Reset, neuer DB_PATH) jeder im LAN,
  // der den Namen zuerst registriert, (a) Admin werden und (b) den Namen
  // dauerhaft belegen und so den echten Betreiber aussperren. Die Prüfung gilt
  // AUCH wenn schon ein Admin existiert — der Name bleibt dem Betreiber
  // vorbehalten. Wichtig: ablehnen heißt KEIN User-Insert, der Name bleibt frei.
  if (
    config.adminUsername !== undefined &&
    config.adminBootstrapToken != null &&
    usernameResult.data === config.adminUsername
  ) {
    const eingereicht = input.bootstrapToken ?? '';
    if (eingereicht === '' || !bootstrapTokenGueltig(eingereicht, config.adminBootstrapToken)) {
      throw new DomainError(BOOTSTRAP_RESERVED_MESSAGE);
    }
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
    // Timing-Oracle schließen: auch der unbekannte Nutzer kostet einen vollen
    // argon2-Verify (gegen den festen Dummy-Hash) — sonst wäre über die
    // Antwortzeit messbar, welche Benutzernamen existieren. Das Ergebnis ist
    // egal; die Meldung ist dieselbe wie bei falschem Passwort.
    await Bun.password.verify(password, DUMMY_PASSWORD_HASH);
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
  if (!user) {
    // Der Bootstrap-Name ist gesetzt, aber noch unbelegt. Ohne
    // MACVIBES_ADMIN_BOOTSTRAP_TOKEN reserviert register() den Namen NICHT —
    // solange kein Admin existiert, kann also jeder im Netz den Namen
    // beanspruchen und wird Admin. Das muss der Betreiber beim Start deutlich
    // sehen (existiert bereits ein Admin, ist der Bootstrap-Pfad tot und die
    // Warnung nur Rauschen).
    if (config.adminBootstrapToken == null) {
      const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
      if (admins.length === 0) {
        console.warn(
          `SICHERHEITSHINWEIS: Noch KEIN Admin vorhanden und der Bootstrap-Name "${username}" ` +
            'ist UNGESCHÜTZT — wer sich zuerst mit diesem Namen registriert, wird Admin ' +
            '(der Server lauscht im LAN/VPN). Setze MACVIBES_ADMIN_BOOTSTRAP_TOKEN=<zufälliges Secret> ' +
            '(z. B. `openssl rand -hex 32`) in der .env; die Erst-Registrierung verlangt dann dieses Token.',
        );
      }
    }
    return;
  }
  if (user.role === 'admin' && user.approved) return;

  // F21: Beförderung nur als echter Bootstrap — solange KEIN Admin existiert.
  // Vorher wurde bei jedem Start befördert, wer gerade den konfigurierten
  // Namen trug; da register den Namen nicht reserviert und .env.example ihn
  // verrät, konnte ein Fremder ihn vorbelegen und wurde beim nächsten
  // Neustart Admin.
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
  const erzwungen = config.forceAdmin === true;
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

  // Rollierend verlängern, aber nicht bei JEDEM Request: das Frontend pollt im
  // Sekundentakt, das wären dutzende Schreibvorgänge pro Minute und Nutzer auf
  // derselben Zeile — die unter bun:sqlite mit jedem anderen Schreiber
  // konkurrieren. Es genügt, nachzuziehen, sobald ein nennenswerter Teil der
  // Frist verstrichen ist; die Session verlängert sich dadurch genauso.
  const restMs = session.expiresAt.getTime() - Date.now();
  if (restMs < config.sessionTtlMs / 2) {
    const newExpiry = new Date(Date.now() + config.sessionTtlMs);
    await db.update(sessions).set({ expiresAt: newExpiry }).where(eq(sessions.id, key));
  }

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
