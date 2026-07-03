import { createRoot } from 'react-dom/client';
import { App } from './App';
import { NotesStore } from './models/NotesStore';
import './styles.css';

const store = new NotesStore();
void store.load();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root-Element #root wurde nicht gefunden.');
}

createRoot(container).render(<App store={store} />);
