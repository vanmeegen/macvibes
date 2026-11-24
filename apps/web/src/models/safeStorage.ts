/** Der Ausschnitt von `Storage`, den die Stores für ihre Einstellungen brauchen. */
export type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage des Browsers — im SSR-/Testkontext ggf. nicht vorhanden. */
export function browserStorage(): SettingsStorage {
  if (typeof localStorage !== 'undefined') return localStorage;
  return { getItem: () => null, setItem: () => {} };
}

/**
 * Liest eine gespeicherte Einstellung. localStorage kann werfen (Private-Modus,
 * gesperrte Website-Daten) — dann gilt der Default des Aufrufers (`null`).
 */
export function readSetting(storage: SettingsStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch (err) {
    console.error(`Einstellung „${key}" konnte nicht gelesen werden`, err);
    return null;
  }
}

/** Speichert eine Einstellung; ein Fehlschlag kostet nur die Persistenz, nicht die Aktion. */
export function writeSetting(storage: SettingsStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch (err) {
    console.error(`Einstellung „${key}" konnte nicht gespeichert werden`, err);
  }
}
