import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // macvibes-Kontrakt: die Plattform setzt PORT für die Preview (Fallback 5173).
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    host: true,
    proxy: {
      '/graphql': 'http://localhost:4000',
    },
  },
});
