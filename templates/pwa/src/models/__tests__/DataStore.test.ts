import { describe, expect, test } from 'bun:test';
import { DataStore } from '../DataStore';

// Beispiel für einen Store-Test: Logik lebt im Store, also wird sie dort
// geprüft — ohne Browser, ohne Komponenten.
describe('DataStore', () => {
  test('startet mit Beispieldaten und leitet Achse und Datenreihen daraus ab', () => {
    const store = new DataStore();
    expect(store.isSampleData).toBe(true);
    expect(store.labelKey).toBe('Monat');
    expect(store.valueKeys).toEqual(['Umsatz', 'Kosten']);
  });
});
