/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Für E2E-Läufe zeigt der Proxy auf einen isolierten Test-Server (eigener Port).
const apiPort = process.env.MACVIBES_API_PORT ?? '4000';
// Web-Dev-Port: Default 5173, per Env überschreibbar (keine hart codierten Ports).
const webPort = Number(process.env.MACVIBES_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: webPort,
    // F7: `host: true` bindet 0.0.0.0, und Vites /@fs/-Handler liefert ohne
    // Grenze alles unterhalb des Repo-Roots aus — darunter die SQLite-DB mit
    // Session-Tokens im Klartext. `strict` beschränkt auf die erlaubten
    // Wurzeln, `deny` sperrt zusätzlich die sensiblen Muster.
    fs: {
      strict: true,
      deny: ['**/.env', '**/.env.*', '**/*.db', '**/*.db-wal', '**/*.db-shm', '**/data/**'],
    },
    proxy: {
      '/graphql': {
        target: `http://localhost:${apiPort}`,
        // changeOrigin BEWUSST aus: es überschriebe den Host-Header mit
        // `localhost:<apiPort>`, und die Origin-Allowlist des Servers leitet
        // die erlaubten Dev-Origins aus genau diesem Host ab (originPolicy).
        // Damit wäre nur `localhost:5173` erlaubt — ein Zugriff vom Handy/iPad
        // über die LAN-IP (oder per VPN) käme mit Origin `http://<ip>:5173`
        // und liefe in ein 403. Ohne changeOrigin reicht Vite den echten Host
        // durch, die Allowlist passt für localhost UND LAN-IP.
        // Der Server bindet 0.0.0.0 und routet nicht nach Host — das
        // Durchreichen ist deshalb unkritisch.
        changeOrigin: false,
      },
    },
  },
  optimizeDeps: {
    include: ['zod'],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['**/__tests__/**/*.spec.{ts,tsx}'],
    css: false,
    server: {
      deps: {
        inline: ['zod', /@macvibes\//],
      },
    },
  },
});
