import { observer } from 'mobx-react-lite';
import type { NotesStore } from './models/NotesStore';

const dateFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const App = observer(({ store }: { store: NotesStore }) => (
  <main className="app">
    <h1>Notizen</h1>
    <form
      className="app__form"
      onSubmit={(event) => {
        event.preventDefault();
        void store.add();
      }}
    >
      <input
        type="text"
        value={store.draft}
        placeholder="Neue Notiz …"
        onChange={(event) => store.setDraft(event.target.value)}
      />
      <button type="submit" disabled={!store.canAdd}>
        Hinzufügen
      </button>
    </form>
    {store.error !== null && (
      <p className="app__error" role="alert">
        {store.error}
      </p>
    )}
    {store.loading && store.notes.length === 0 ? (
      <p className="app__hint">Lade Notizen …</p>
    ) : store.notes.length === 0 ? (
      <p className="app__hint">Noch keine Notizen vorhanden.</p>
    ) : (
      <ul className="app__list">
        {store.notes.map((note) => (
          <li key={note.id}>
            <span>{note.text}</span>
            <time dateTime={note.createdAt}>{dateFormat.format(new Date(note.createdAt))}</time>
          </li>
        ))}
      </ul>
    )}
  </main>
));
