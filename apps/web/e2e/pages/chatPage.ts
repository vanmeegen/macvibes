import type { Locator, Page } from '@playwright/test';

export class ChatPage {
  constructor(private readonly page: Page) {}

  get backButton(): Locator {
    return this.page.getByTestId('chat-back-button');
  }

  get chatInput(): Locator {
    return this.page.getByTestId('chat-input');
  }

  get readonlyHint(): Locator {
    return this.page.getByTestId('chat-readonly-hint');
  }

  get sandboxStatus(): Locator {
    return this.page.getByTestId('chat-sandbox-status');
  }
}
