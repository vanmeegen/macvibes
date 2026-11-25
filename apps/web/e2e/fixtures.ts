import { expect, request, test as base, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_ADMIN_USERNAME, E2E_PASSWORD, E2E_WEB_PORT } from '../playwright.config';
import { AdminPage } from './pages/adminPage';
import { ChatPage } from './pages/chatPage';
import { LoginPage } from './pages/loginPage';
import { ProjectsPage } from './pages/projectsPage';

export { expect };

/** Passwort aller E2E-Nutzer (Admin wie frisch registrierte). */
export const PASSWORD = E2E_PASSWORD;
/** Zugangsdaten des E2E-Admins (für UI-Login als Admin) — angelegt im globalSetup. */
export const ADMIN_CREDENTIALS = { username: E2E_ADMIN_USERNAME, password: E2E_PASSWORD };

const WEB_BASE = `http://localhost:${E2E_WEB_PORT}`;

/** Page-Objects als Fixtures — jeder Test nimmt sich, was er braucht. */
export const test = base.extend<{
  loginPage: LoginPage;
  projectsPage: ProjectsPage;
  chatPage: ChatPage;
  adminPage: AdminPage;
}>({
  loginPage: async ({ page }, run) => {
    await run(new LoginPage(page));
  },
  projectsPage: async ({ page }, run) => {
    await run(new ProjectsPage(page));
  },
  chatPage: async ({ page }, run) => {
    await run(new ChatPage(page));
  },
  adminPage: async ({ page }, run) => {
    await run(new AdminPage(page));
  },
});

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

// Der E2E-Admin wird im globalSetup angelegt. Hier melden wir uns per API-Login
// als dieser Admin an — deterministisch und robust, auch wenn Playwright die
// Fixture-Module pro Testdatei neu lädt (dann wird der Kontext einfach neu
// aufgebaut).
let adminApi: APIRequestContext | null = null;

async function ensureAdminApi(): Promise<APIRequestContext> {
  if (adminApi) return adminApi;
  const ctx = await request.newContext({ baseURL: WEB_BASE });
  await gql(ctx, LOGIN, { u: ADMIN_CREDENTIALS.username, p: ADMIN_CREDENTIALS.password });
  adminApi = ctx;
  return ctx;
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
  const username = uniqueUsername();
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.register(username, PASSWORD);
  await approvePendingViaApi(username);
  await loginPage.login(username, PASSWORD);
  await expect(new ProjectsPage(page).newProjectFab).toBeVisible();
  return username;
}

/**
 * Häufigster Testeinstieg: frischer Nutzer, der ein eigenes Projekt anlegt und
 * danach in dessen Chat steht. Liefert den Projektnamen.
 */
export async function createOwnProject(
  page: Page,
  namePrefix: string,
  templateDir = 'pwa',
): Promise<string> {
  await registerNewUser(page);
  const name = uniqueProjectName(namePrefix);
  await new ProjectsPage(page).createProject(name, templateDir);
  return name;
}

/**
 * Wechselt vom Eigentümer zu einem frischen zweiten Nutzer, der das (fremde)
 * Projekt über den Filter „Alle" öffnet — der Nur-Lese-Besucher (R10).
 * `waitAfterLogoutMs`: Pause zwischen Abmelden und Besuch, z. B. damit die
 * Grace-Period der Sandbox sicher abgelaufen ist.
 */
export async function openAsVisitor(
  page: Page,
  projectName: string,
  options: { waitAfterLogoutMs?: number } = {},
): Promise<void> {
  const projectsPage = new ProjectsPage(page);
  // Der Eigentümer steht nach dem Anlegen im Chat — zurück zur Liste zum Abmelden.
  await projectsPage.goto();
  await projectsPage.logout();
  if (options.waitAfterLogoutMs !== undefined) {
    await page.waitForTimeout(options.waitAfterLogoutMs);
  }
  await registerNewUser(page);
  await projectsPage.filterAll.click();
  await projectsPage.openProject(projectName);
}
