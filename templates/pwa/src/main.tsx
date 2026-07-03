import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DataStore } from './models/DataStore';
import './styles.css';

const store = new DataStore();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root-Element #root wurde nicht gefunden.');
}

createRoot(container).render(<App store={store} />);
