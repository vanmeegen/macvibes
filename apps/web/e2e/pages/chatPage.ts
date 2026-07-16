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

  get sendButton(): Locator {
    return this.page.getByTestId('chat-send');
  }

  /** Modellwahl-Dropdown in der Toolbar (nur Owner sichtbar). */
  get modelSelect(): Locator {
    return this.page.getByTestId('chat-model-select');
  }

  modelOption(modelId: string): Locator {
    return this.page.getByTestId(`chat-model-option-${modelId}`);
  }

  async selectModel(modelId: string): Promise<void> {
    await this.modelSelect.click();
    await this.modelOption(modelId).click();
  }

  get stopButton(): Locator {
    return this.page.getByTestId('chat-stop');
  }

  /** Mikro-Button fürs Diktat (lokale Browser-Erkennung). */
  get micButton(): Locator {
    return this.page.getByTestId('chat-mic');
  }

  /** DE/EN-Badge neben dem Mikro-Button. */
  get micLang(): Locator {
    return this.page.getByTestId('chat-mic-lang');
  }

  messagesByRole(role: 'user' | 'assistant' | 'tool' | 'system' | 'error'): Locator {
    return this.page.locator(`[data-testselector="chat-message"][data-role="${role}"]`);
  }

  async send(text: string): Promise<void> {
    await this.chatInput.fill(text);
    await this.sendButton.click();
  }
}
