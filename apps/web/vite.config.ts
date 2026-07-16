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
    proxy: {
      '/graphql': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
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
