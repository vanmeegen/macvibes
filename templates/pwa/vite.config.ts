import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: {
    // macvibes-Kontrakt: die Plattform setzt PORT für die Preview (Fallback 5173).
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    host: true,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'App',
        short_name: 'App',
        lang: 'de',
        theme_color: '#2a78d6',
        background_color: '#f9f9f7',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
        ],
      },
    }),
  ],
});
