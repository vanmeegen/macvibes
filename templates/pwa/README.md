# Client-PWA (React + MobX, Bun-nativ)

Schlanke Progressive Web App **ohne Server** — läuft komplett im Browser.
Die Toolchain ist bewusst minimal: **nur Bun**, kein Vite, kein Bundler-Zoo
(siehe `Frameworkcomparison.md` im Plattform-Repo).

- **Dev:** `bun install && bun run dev` — `Bun.serve` mit HMR + React Fast Refresh
  (Port über `PORT`-Env, Fallback 5173)
- **Build:** `bun run build` — Typecheck + `Bun.build` nach `dist/`
- **Tests:** `bun test`

## Was drin ist

- React 18 + MobX (Presentation-Model: Logik in `src/models/`, Komponenten logikfrei)
- **Excel-Upload per Drag & Drop** (SheetJS): Datei auf die Seite ziehen,
  Daten landen typisiert im `DataStore`
- **Recharts-Dashboard**, das die hochgeladenen Daten sofort rendert
  (mit eingebauten Beispieldaten)
- PWA: Manifest + minimaler Service Worker (`public/`), Registrierung nur im
  Produktions-Build
