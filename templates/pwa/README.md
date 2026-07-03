# Client-PWA (React + MobX)

Schlanke Progressive Web App ohne Server: React, MobX und Vite. Excel-Dateien
lassen sich per Drag & Drop (SheetJS) laden und werden als Recharts-Dashboard
direkt im Browser ausgewertet — inklusive Beispieldaten, damit sofort etwas zu
sehen ist.

## Starten

```sh
bun install
bun run dev
```

Die App läuft dann auf <http://localhost:5173>.

## Struktur

- `src/models/DataStore.ts` — MobX-Store (Presentation Model): Daten, Fehler, Aggregation
- `src/components/ExcelDropZone.tsx` — Drag & Drop + Dateiauswahl
- `src/components/DemoChart.tsx` — Balkendiagramm + Datentabelle

Weitere Befehle: `bun run typecheck`, `bun run build`, `bun run preview`.
