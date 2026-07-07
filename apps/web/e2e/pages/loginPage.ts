import type { Locator, Page } from '@playwright/test';

export class LoginPage {
  constructor(private readonly page: Page) {}

  get usernameInput(): Locator {
    return this.page.getByTestId('login-username');
  }

  get passwordInput(): Locator {
    return this.page.getByTestId('login-password');
  }

  get submitButton(): Locator {
    return this.page.getByTestId('login-submit');
  }

  get errorAlert(): Locator {
    return this.page.getByTestId('login-error');
  }

  get noticeAlert(): Locator {
    return this.page.getByTestId('login-notice');
  }

  async goto(): Promise<void> {
    await this.page.goto('/login');
  }

  private modeButton(mode: 'login' | 'register'): Locator {
    return this.page.getByTestId('login-mode-toggle').locator(`button[value="${mode}"]`);
  }

  async register(username: string, password: string): Promise<void> {
    await this.modeButton('register').click();
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
    // Warten, bis die Registrierung verarbeitet ist (pending-Hinweis oder Fehler).
    // Sonst wischt der noch laufende Request (pending-Zweig setzt das Passwort
    // zurück) einen direkt folgenden login() weg.
    await this.noticeAlert.or(this.errorAlert).first().waitFor();
  }

  async login(username: string, password: string): Promise<void> {
    await this.modeButton('login').click();
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }
}
