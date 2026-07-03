import { makeAutoObservable, runInAction } from 'mobx';

export interface Note {
  id: number;
  text: string;
  createdAt: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function graphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`GraphQL-Anfrage fehlgeschlagen: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as GraphQLResponse<T>;
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(payload.errors.map((e) => e.message).join('; '));
  }
  if (!payload.data) {
    throw new Error('GraphQL-Antwort enthält keine Daten.');
  }
  return payload.data;
}

/**
 * Presentation-Model für die Notizliste: lädt Notizen, legt neue an und
 * hält Eingabe-, Lade- und Fehlerzustand. Die Komponenten sind reine
 * `observer` ohne eigene Logik.
 */
export class NotesStore {
  notes: Note[] = [];
  draft = '';
  loading = false;
  error: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  setDraft(value: string): void {
    this.draft = value;
  }

  get canAdd(): boolean {
    return this.draft.trim().length > 0 && !this.loading;
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const data = await graphqlRequest<{ notes: Note[] }>('query { notes { id text createdAt } }');
      runInAction(() => {
        this.notes = data.notes;
      });
    } catch (err) {
      // Fehler niemals verschlucken: loggen und sichtbar im UI melden.
      console.error('Notizen konnten nicht geladen werden:', err);
      runInAction(() => {
        this.error = err instanceof Error ? err.message : String(err);
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  async add(): Promise<void> {
    const text = this.draft.trim();
    if (text.length === 0) {
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const data = await graphqlRequest<{ addNote: Note }>(
        'mutation ($text: String!) { addNote(text: $text) { id text createdAt } }',
        { text },
      );
      runInAction(() => {
        this.notes = [data.addNote, ...this.notes];
        this.draft = '';
      });
    } catch (err) {
      // Fehler niemals verschlucken: loggen und sichtbar im UI melden.
      console.error('Notiz konnte nicht angelegt werden:', err);
      runInAction(() => {
        this.error = err instanceof Error ? err.message : String(err);
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }
}
