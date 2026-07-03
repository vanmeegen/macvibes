// Produktions-Build mit Bun.build — bündelt index.html samt Skripten/Assets.
import { cpSync } from 'node:fs';

const result = await Bun.build({
  entrypoints: ['./index.html'],
  outdir: './dist',
  minify: true,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

// PWA-Dateien (Manifest, Service Worker, Icon) unverändert übernehmen.
cpSync('public', 'dist', { recursive: true });
console.log(`Build fertig: ${result.outputs.length} Dateien in dist/`);
