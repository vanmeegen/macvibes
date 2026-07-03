import { expect, type Page } from '@playwright/test';
import { E2E_INVITE_CODE } from '../playwright.config';
import { LoginPage } from './pages/loginPage';
import { ProjectsPage } from './pages/projectsPage';

export const INVITE_CODE = E2E_INVITE_CODE;
export const PASSWORD = 'passwort123';

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

/** Registriert einen frischen User und wartet, bis die Projektübersicht steht. */
export async function registerNewUser(page: Page): Promise<string> {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  const username = uniqueUsername();
  await loginPage.register(username, PASSWORD, INVITE_CODE);
  await expect(new ProjectsPage(page).newProjectFab).toBeVisible();
  return username;
}
