import { describe, expect, it } from 'vitest';
import type { AuthStore } from '../AuthStore';
import { LoginModel } from '../LoginModel';

/**
 * LoginModel war das einzige Presentation-Model ohne Spec — entgegen der
 * verbindlichen TDD-Regel des Projekts. Ausgerechnet hier hängt daran das
 * Verhalten nach einer Registrierung, die auf Freischaltung wartet: Das Modell
 * wechselt dann in den Login-Modus zurueck, ohne den Hinweistext des AuthStore
 * zu zerstören, und meldet trotzdem Erfolg.
 */

interface AufrufProtokoll {
  logins: Array<[string, string]>;
  /** [username, password] bzw. [username, password, bootstrapToken]. */
  registrierungen: Array<[string, string] | [string, string, string]>;
  fehlerGeleert: number;
}

function fakeAuthStore(
  ergebnisse: {
    login?: boolean;
    register?: 'loggedIn' | 'pending' | 'failed';
    pending?: boolean;
  } = {},
): { store: AuthStore; protokoll: AufrufProtokoll } {
  const protokoll: AufrufProtokoll = { logins: [], registrierungen: [], fehlerGeleert: 0 };
  const store = {
    pending: ergebnisse.pending ?? false,
    clearError: (): void => {
      protokoll.fehlerGeleert += 1;
    },
    login: (username: string, password: string): Promise<boolean> => {
      protokoll.logins.push([username, password]);
      return Promise.resolve(ergebnisse.login ?? true);
    },
    register: (
      username: string,
      password: string,
      bootstrapToken?: string,
    ): Promise<'loggedIn' | 'pending' | 'failed'> => {
      // Nur definierte Argumente protokollieren — die Alt-Assertions ohne
      // Token bleiben so unverändert gültig.
      protokoll.registrierungen.push(
        bootstrapToken === undefined ? [username, password] : [username, password, bootstrapToken],
      );
      return Promise.resolve(ergebnisse.register ?? 'loggedIn');
    },
  } as unknown as AuthStore;
  return { store, protokoll };
}

describe('LoginModel', () => {
  describe('canSubmit', () => {
    it('verlangt Benutzername und Passwort', () => {
      const { store } = fakeAuthStore();
      const model = new LoginModel(store);
      expect(model.canSubmit).toBe(false);

      model.setUsername('marco');
      expect(model.canSubmit).toBe(false);

      model.setPassword('passwort123');
      expect(model.canSubmit).toBe(true);
    });

    it('lässt reine Leerzeichen als Benutzernamen nicht gelten', () => {
      const { store } = fakeAuthStore();
      const model = new LoginModel(store);
      model.setUsername('   ');
      model.setPassword('passwort123');
      expect(model.canSubmit).toBe(false);
    });

    it('sperrt, solange der AuthStore arbeitet — kein Doppelabsenden', () => {
      const { store } = fakeAuthStore({ pending: true });
      const model = new LoginModel(store);
      model.setUsername('marco');
      model.setPassword('passwort123');
      expect(model.canSubmit).toBe(false);
    });
  });

  describe('setMode', () => {
    it('wechselt den Modus und räumt die alte Fehlermeldung weg', () => {
      const { store, protokoll } = fakeAuthStore();
      const model = new LoginModel(store);
      model.setMode('register');
      expect(model.mode).toBe('register');
      expect(protokoll.fehlerGeleert).toBe(1);
    });
  });

  describe('submit im Login-Modus', () => {
    it('meldet mit getrimmtem Benutzernamen an und leert danach die Felder', async () => {
      const { store, protokoll } = fakeAuthStore({ login: true });
      const model = new LoginModel(store);
      model.setUsername('  marco  ');
      model.setPassword('passwort123');

      expect(await model.submit()).toBe(true);

      expect(protokoll.logins).toEqual([['marco', 'passwort123']]);
      expect(model.username).toBe('');
      expect(model.password).toBe('');
    });

    it('behält die Eingaben bei falschem Passwort — der Nutzer korrigiert nur eines', async () => {
      const { store } = fakeAuthStore({ login: false });
      const model = new LoginModel(store);
      model.setUsername('marco');
      model.setPassword('falsch');

      expect(await model.submit()).toBe(false);

      expect(model.username).toBe('marco');
      expect(model.password).toBe('falsch');
    });
  });

  describe('submit im Registrieren-Modus', () => {
    it('erste Registrierung meldet direkt an und leert die Felder', async () => {
      const { store, protokoll } = fakeAuthStore({ register: 'loggedIn' });
      const model = new LoginModel(store);
      model.setMode('register');
      model.setUsername(' marco ');
      model.setPassword('passwort123');

      expect(await model.submit()).toBe(true);

      expect(protokoll.registrierungen).toEqual([['marco', 'passwort123']]);
      expect(model.username).toBe('');
      expect(model.mode).toBe('login');
    });

    it('wartende Freischaltung: zurück in den Login-Modus, Benutzername bleibt stehen', async () => {
      const { store } = fakeAuthStore({ register: 'pending' });
      const model = new LoginModel(store);
      model.setMode('register');
      model.setUsername('gast');
      model.setPassword('passwort123');

      expect(await model.submit()).toBe(true);

      expect(model.mode).toBe('login');
      // Der Name bleibt, damit der Nutzer sich nach der Freischaltung sofort
      // anmelden kann; das Passwort wird bewusst geleert.
      expect(model.username).toBe('gast');
      expect(model.password).toBe('');
    });

    it('reicht den Bootstrap-Token getrimmt an den AuthStore weiter (Erst-Admin)', async () => {
      const { store, protokoll } = fakeAuthStore({ register: 'loggedIn' });
      const model = new LoginModel(store);
      model.setMode('register');
      model.setUsername('marco');
      model.setPassword('passwort123');
      model.setBootstrapToken('  boot-tok-123  ');

      expect(await model.submit()).toBe(true);

      expect(protokoll.registrierungen).toEqual([['marco', 'passwort123', 'boot-tok-123']]);
    });

    it('leeres Token-Feld: es wird KEIN Token mitgeschickt (Normalfall aller Nutzer)', async () => {
      const { store, protokoll } = fakeAuthStore({ register: 'pending' });
      const model = new LoginModel(store);
      model.setMode('register');
      model.setUsername('gast');
      model.setPassword('passwort123');

      expect(await model.submit()).toBe(true);

      expect(protokoll.registrierungen).toEqual([['gast', 'passwort123']]);
    });

    it('gescheiterte Registrierung bleibt im Registrieren-Modus', async () => {
      const { store } = fakeAuthStore({ register: 'failed' });
      const model = new LoginModel(store);
      model.setMode('register');
      model.setUsername('marco');
      model.setPassword('passwort123');

      expect(await model.submit()).toBe(false);

      expect(model.mode).toBe('register');
      expect(model.username).toBe('marco');
    });
  });

  describe('reset', () => {
    it('setzt Felder und Modus zurück', () => {
      const { store } = fakeAuthStore();
      const model = new LoginModel(store);
      model.setMode('register');
      model.setUsername('marco');
      model.setPassword('passwort123');
      model.setBootstrapToken('boot-tok-123');

      model.reset();

      expect(model.username).toBe('');
      expect(model.password).toBe('');
      expect(model.bootstrapToken).toBe('');
      expect(model.mode).toBe('login');
    });
  });
});
