import { makeAutoObservable, runInAction } from 'mobx';
import { read, utils } from 'xlsx';

/** Eine Zeile aus dem Tabellenblatt, wie sie SheetJS liefert. */
export type Row = Record<string, string | number | boolean | null>;

const SAMPLE_ROWS: Row[] = [
  { Monat: 'Jan', Umsatz: 12500, Kosten: 8300 },
  { Monat: 'Feb', Umsatz: 14200, Kosten: 8900 },
  { Monat: 'Mär', Umsatz: 13100, Kosten: 9100 },
  { Monat: 'Apr', Umsatz: 15800, Kosten: 9400 },
  { Monat: 'Mai', Umsatz: 17300, Kosten: 9800 },
  { Monat: 'Jun', Umsatz: 16400, Kosten: 10200 },
];

/**
 * Presentation-Model für das Dashboard: hält die geladenen Tabellendaten
 * und leitet daraus chart-fertige Aggregationen ab. Die Komponenten sind
 * reine `observer` ohne eigene Logik.
 */
export class DataStore {
  rows: Row[] = SAMPLE_ROWS;
  fileName: string | null = null;
  sheetName: string | null = null;
  error: string | null = null;
  loading = false;

  constructor() {
    makeAutoObservable(this);
  }

  /** Solange keine Datei geladen wurde, zeigen wir die Beispieldaten. */
  get isSampleData(): boolean {
    return this.fileName === null;
  }

  /** Erste Spalte mit Textwerten dient als Beschriftungsachse. */
  get labelKey(): string | null {
    const first = this.rows[0];
    if (!first) {
      return null;
    }
    for (const [key, value] of Object.entries(first)) {
      if (typeof value === 'string') {
        return key;
      }
    }
    return Object.keys(first)[0] ?? null;
  }

  /** Alle numerischen Spalten werden als Datenreihen dargestellt. */
  get valueKeys(): string[] {
    const first = this.rows[0];
    if (!first) {
      return [];
    }
    return Object.entries(first)
      .filter(([key, value]) => key !== this.labelKey && typeof value === 'number')
      .map(([key]) => key);
  }

  /**
   * Chart-fertige Aggregation: Zeilen mit gleicher Beschriftung werden
   * zusammengefasst, numerische Werte pro Datenreihe aufsummiert.
   */
  get chartRows(): Record<string, string | number>[] {
    const labelKey = this.labelKey;
    if (labelKey === null) {
      return [];
    }
    const byLabel = new Map<string, Record<string, string | number>>();
    for (const row of this.rows) {
      const label = String(row[labelKey] ?? '');
      let entry = byLabel.get(label);
      if (!entry) {
        entry = { [labelKey]: label };
        byLabel.set(label, entry);
      }
      for (const key of this.valueKeys) {
        const value = row[key];
        if (typeof value === 'number') {
          const previous = entry[key];
          entry[key] = (typeof previous === 'number' ? previous : 0) + value;
        }
      }
    }
    return [...byLabel.values()];
  }

  /** Liest eine Excel-Datei ein und ersetzt die aktuellen Daten. */
  async loadWorkbook(file: File): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const buffer = await file.arrayBuffer();
      const workbook = read(buffer);
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        throw new Error('Die Arbeitsmappe enthält kein Tabellenblatt.');
      }
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) {
        throw new Error(`Das Tabellenblatt "${sheetName}" konnte nicht gelesen werden.`);
      }
      const rows = utils.sheet_to_json<Row>(sheet, { defval: null });
      if (rows.length === 0) {
        throw new Error(`Das Tabellenblatt "${sheetName}" enthält keine Daten.`);
      }
      runInAction(() => {
        this.rows = rows;
        this.fileName = file.name;
        this.sheetName = sheetName;
      });
    } catch (err) {
      // Fehler niemals verschlucken: loggen und sichtbar im UI melden.
      console.error('Fehler beim Laden der Excel-Datei:', err);
      runInAction(() => {
        this.error =
          err instanceof Error
            ? `Die Datei konnte nicht gelesen werden: ${err.message}`
            : `Die Datei konnte nicht gelesen werden: ${String(err)}`;
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }
}
