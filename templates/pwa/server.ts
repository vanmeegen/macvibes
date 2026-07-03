// Bun-nativer Dev-Server: bündelt index.html samt TSX on the fly,
// mit HMR + React Fast Refresh — ganz ohne Vite.
// macvibes-Kontrakt: die Plattform setzt PORT (Fallback 5173).
import index from './index.html';

const port = Number(process.env.PORT ?? 5173);

Bun.serve({
  port,
  hostname: '0.0.0.0',
  development: {
    hmr: true,
    console: true,
  },
  routes: {
    '/manifest.webmanifest': () => new Response(Bun.file('public/manifest.webmanifest')),
    '/icon.svg': () => new Response(Bun.file('public/icon.svg')),
    '/sw.js': () => new Response(Bun.file('public/sw.js')),
    '/*': index,
  },
});

console.log(`Dev-Server läuft auf http://localhost:${port}`);
