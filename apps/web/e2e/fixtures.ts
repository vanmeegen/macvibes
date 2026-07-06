import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_WEB_PORT } from '../playwright.config';
import { ADMIN_PASSWORD, ADMIN_USERNAME } from './globalSetup';
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

const USERS = `{users{id username approved}}`;
const APPROVE = `mutation($id:ID!){approveUser(userId:$id){id approved}}`;
const LOGIN = `mutation($u:String!,$p:String!){login(username:$u,password:$p){id role}}`;

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

// Der E2E-Admin (e2eadmin) wird im globalSetup als Erst-Nutzer angelegt. Hier
// melden wir uns per API-Login als dieser Admin an — deterministisch und robust,
// auch wenn Playwright die Fixture-Module pro Testdatei neu lädt (dann wird der
// Kontext einfach neu aufgebaut, statt versehentlich einen zweiten Erst-Nutzer
// zu registrieren, der gar keiner mehr wäre).
let adminApi: APIRequestContext | null = null;

async function ensureAdminApi(): Promise<APIRequestContext> {
  if (adminApi) return adminApi;
  const ctx = await request.newContext({ baseURL: WEB_BASE });
  await gql(ctx, LOGIN, { u: ADMIN_USERNAME, p: ADMIN_PASSWORD });
  adminApi = ctx;
  return ctx;
}

/** Sorgt dafür, dass der Admin-Kontext bereitsteht (für Tests des pending-Flows). */
export async function ensureAdminExists(): Promise<void> {
  await ensureAdminApi();
}

/** Zugangsdaten des E2E-Admins (für UI-Login als Admin). */
export async function getAdminCredentials(): Promise<{ username: string; password: string }> {
  await ensureAdminApi();
  return { username: ADMIN_USERNAME, password: ADMIN_PASSWORD };
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
