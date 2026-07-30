import { request } from '@playwright/test';
import { E2E_ADMIN_USERNAME, E2E_WEB_PORT } from '../playwright.config';

// Fester E2E-Admin: wird als ALLERERSTER Nutzer des Laufs registriert. Seit H3
// macht das allein noch keinen Admin — der Name ist zusätzlich als
// MACVIBES_ADMIN_USERNAME gesetzt (playwright.config.ts), deshalb kommt er von
// dort und wird hier nicht zweitgeschrieben. Die Fixtures melden sich später
// deterministisch als dieser Admin an (Login statt Registrierung) — unabhängig
// davon, wie oft Playwright die Fixture-Module pro Testdatei neu lädt.
export const ADMIN_USERNAME = E2E_ADMIN_USERNAME;
export const ADMIN_PASSWORD = 'passwort123';

const REGISTER = `mutation($u:String!,$p:String!){register(username:$u,password:$p){role approved}}`;

/** Legt den E2E-Admin an, bevor irgendein Test läuft (frische DB pro Lauf). */
async function globalSetup(): Promise<void> {
  const ctx = await request.newContext({ baseURL: `http://localhost:${E2E_WEB_PORT}` });
  try {
    const res = await ctx.post('/graphql', {
      data: { query: REGISTER, variables: { u: ADMIN_USERNAME, p: ADMIN_PASSWORD } },
    });
    const json = (await res.json()) as {
      data?: { register?: { role: string; approved: boolean } };
      errors?: unknown;
    };
    const reg = json.data?.register;
    if (!reg && !json.errors) {
      throw new Error('E2E-globalSetup: unerwartete Antwort beim Admin-Anlegen');
    }
    if (reg && !(reg.role === 'admin' && reg.approved)) {
      throw new Error(
        `E2E-globalSetup: „${ADMIN_USERNAME}" wurde nicht Admin — ` +
          'MACVIBES_ADMIN_USERNAME muss auf denselben Namen zeigen (H3).',
      );
    }
  } finally {
    await ctx.dispose();
  }
}

export default globalSetup;
