import type { Locator, Page } from '@playwright/test';

export class AdminPage {
  constructor(private readonly page: Page) {}

  /** Tabellenzeile eines Nutzers (trägt `data-approved`). */
  userRow(username: string): Locator {
    return this.page.locator(`[data-testselector="admin-user-row"][data-username="${username}"]`);
  }

  approveButtonIn(row: Locator): Locator {
    return row.getByTestId('admin-approve');
  }
}
