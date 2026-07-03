import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/600.css';
import '@fontsource/open-sans/700.css';

import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { authStore } from './models/stores';
import { theme } from './theme';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root-Container #root wurde in index.html nicht gefunden');
}

// Einmalig die Session prüfen; App wartet auf authStore.initialized.
void authStore.loadMe();

createRoot(container).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
