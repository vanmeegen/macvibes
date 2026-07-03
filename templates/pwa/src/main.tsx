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

// Service Worker nur im Produktions-Build registrieren (PWA).
if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((error) => {
    console.error('Service-Worker-Registrierung fehlgeschlagen:', error);
  });
}
