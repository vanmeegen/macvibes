import { makeAutoObservable } from 'mobx';
import type { AuthStore } from './AuthStore';

export type LoginMode = 'login' | 'register';

/**
 * Präsentationsmodell für die Login-/Registrierungsseite.
 * Hält die Formularfelder; die eigentliche Authentifizierung
 * übernimmt der AuthStore.
 */
export class LoginModel {
  mode: LoginMode = 'login';
  username = '';
  password = '';
  /**
   * Bootstrap-Token — nur für die Erst-Registrierung des Admins auf einer
   * Instanz mit gesetztem MACVIBES_ADMIN_BOOTSTRAP_TOKEN. Alle anderen Nutzer
   * lassen das Feld leer; dann wird es gar nicht mitgeschickt.
   */
  bootstrapToken = '';

  constructor(private readonly authStore: AuthStore) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  setMode(mode: LoginMode): void {
    this.mode = mode;
    this.authStore.clearError();
  }

  setUsername(value: string): void {
    this.username = value;
  }

  setPassword(value: string): void {
    this.password = value;
  }

  setBootstrapToken(value: string): void {
    this.bootstrapToken = value;
  }

  get canSubmit(): boolean {
    if (this.username.trim().length === 0 || this.password.length === 0) {
      return false;
    }
    return !this.authStore.pending;
  }

  /**
   * Meldet an bzw. registriert. Bei erfolgreichem Login werden die Felder
   * geleert (die App leitet dann weiter). Eine Registrierung, die auf
   * Freischaltung wartet, wechselt zurück in den Login-Modus — der Hinweis
   * dazu steht im AuthStore (`notice`).
   */
  async submit(): Promise<boolean> {
    if (this.mode === 'login') {
      const ok = await this.authStore.login(this.username.trim(), this.password);
      if (ok) {
        this.reset();
      }
      return ok;
    }

    const token = this.bootstrapToken.trim();
    const outcome = await this.authStore.register(
      this.username.trim(),
      this.password,
      // Leeres Feld = kein Token mitschicken (Normalfall aller Nutzer).
      token === '' ? undefined : token,
    );
    if (outcome === 'loggedIn') {
      this.reset();
      return true;
    }
    if (outcome === 'pending') {
      // Zurück in den Login-Modus, damit der Nutzer sich nach der Freischaltung
      // anmelden kann; der Hinweistext bleibt sichtbar.
      this.password = '';
      this.bootstrapToken = '';
      this.mode = 'login';
      return true;
    }
    return false;
  }

  reset(): void {
    this.username = '';
    this.password = '';
    this.bootstrapToken = '';
    this.mode = 'login';
  }
}
