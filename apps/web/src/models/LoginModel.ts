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
  inviteCode = '';

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

  setInviteCode(value: string): void {
    this.inviteCode = value;
  }

  get canSubmit(): boolean {
    if (this.username.trim().length === 0 || this.password.length === 0) {
      return false;
    }
    if (this.mode === 'register' && this.inviteCode.trim().length === 0) {
      return false;
    }
    return !this.authStore.pending;
  }

  /** Meldet an bzw. registriert; bei Erfolg werden die Felder geleert. */
  async submit(): Promise<boolean> {
    const success =
      this.mode === 'login'
        ? await this.authStore.login(this.username.trim(), this.password)
        : await this.authStore.register(
            this.username.trim(),
            this.password,
            this.inviteCode.trim(),
          );
    if (success) {
      this.reset();
    }
    return success;
  }

  reset(): void {
    this.username = '';
    this.password = '';
    this.inviteCode = '';
    this.mode = 'login';
  }
}
