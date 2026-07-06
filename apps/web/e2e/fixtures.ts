import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_WEB_PORT } from '../playwright.config';
import { LoginPage } from './pages/loginPage';
import { ProjectsPage } from './pages/projectsPage';

export const PASSWORD = 'passwort123';
const WEB_BASE = `http://localhost:${E2E_WEB_PORT}`;

let counter = 0;

/** Eindeutige, username-schema-konforme Namen pro Testlauf. */
export function uniqueUsername(): string {
  counter += 1;
  return `e2e${Date.now().toString(36)}x${counter}`;
}

export function uniqueProjectName(prefix: string): string {
  counter += 1;
  return `${prefix} ${Date.now().toString(36)}${counter}`;
}

const USER_FIELDS = 'id username role approved';
const REGISTER = `mutation($u:String!,$p:String!){register(username:$u,password:$p){${USER_FIELDS}}}`;
const USERS = `{users{id username approved}}`;
const APPROVE = `mutation($id:ID!){approveUser(userId:$id){id approved}}`;

interface GqlUser {
  id: string;
  username: string;
  approved: boolean;
}

async function gql<T>(
  ctx: APIRequestContext,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await ctx.post('/graphql', { data: { query, variables } });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors || !json.data) {
    throw new Error(`GraphQL-Fehler: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// Der Admin ist der ALLERERSTE registrierte Nutzer des Laufs (frische E2E-DB).
// Wir registrieren ihn per API-Kontext, damit sein Session-Cookie für spätere
// Freischaltungen erhalten bleibt.
let adminApi: APIRequestContext | null = null;
let adminUsername: string | null = null;

/**
 * Stellt sicher, dass ein Admin existiert (erster Nutzer des Laufs) und gibt
 * dessen API-Kontext zurück. Idempotent.
 */
async function ensureAdminApi(): Promise<APIRequestContext> {
  if (adminApi) return adminApi;
  const ctx = await request.newContext({ baseURL: WEB_BASE });
  const username = uniqueUsername();
  const data = await gql<{ register: GqlUser & { role: string } }>(ctx, REGISTER, {
    u: username,
    p: PASSWORD,
  });
  if (!data.register.approved) {
    throw new Error('E2E-Bootstrap: erster Nutzer wurde nicht automatisch Admin');
  }
  adminApi = ctx;
  adminUsername = username;
  return ctx;
}

/** Sorgt dafür, dass der Bootstrap-Admin existiert (für Tests des pending-Flows). */
export async function ensureAdminExists(): Promise<void> {
  await ensureAdminApi();
}

/** Zugangsdaten des Bootstrap-Admins (für UI-Login als Admin). */
export async function getAdminCredentials(): Promise<{ username: string; password: string }> {
  await ensureAdminApi();
  return { username: adminUsername!, password: PASSWORD };
}

/** Schaltet einen (per Username bekannten) pending-Nutzer über den Admin frei. */
export async function approvePendingViaApi(username: string): Promise<void> {
  const admin = await ensureAdminApi();
  const { users } = await gql<{ users: GqlUser[] }>(admin, USERS);
  const user = users.find((u) => u.username === username);
  if (!user) {
    throw new Error(`Freischaltung: Nutzer ${username} nicht gefunden`);
  }
  await gql(admin, APPROVE, { id: user.id });
}

/**
 * Registriert einen frischen Nutzer über die UI, schaltet ihn per Admin frei und
 * meldet ihn im `page` an. Deckt den vollständigen Self-Registration-Flow ab und
 * liefert einen einsatzbereiten, eingeloggten Nutzer für die restlichen Tests.
 */
export async function registerNewUser(page: Page): Promise<string> {
  await ensureAdminApi();
  const username = uniqueUsername();
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.register(username, PASSWORD);
  await approvePendingViaApi(username);
  await loginPage.login(username, PASSWORD);
  await expect(new ProjectsPage(page).newProjectFab).toBeVisible();
  return username;
}
