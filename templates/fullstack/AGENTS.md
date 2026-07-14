# Projekt-Kontext für den Agenten (macvibes · Fullstack)

Bun-Workspaces-Monorepo. Der Dev-Server läuft **bereits** (`bun run dev`); Änderungen
erscheinen per HMR **sofort in der Live-Preview**.

## Struktur (hier bearbeiten — relative Pfade, nicht nach `/home/...`)

- **`apps/web/`** — Frontend: React 18 + MobX + Vite.
  - **`apps/web/src/App.tsx` — Wurzel-Komponente, HIER die UI aufbauen.** Nur was von
    hier gerendert wird, ist in der Preview sichtbar.
  - `apps/web/src/components/` (Komponenten), `apps/web/src/models/` (MobX-Stores:
    `makeAutoObservable`, **keine Vererbung**; Komponenten in `observer(...)` wickeln),
    `apps/web/src/styles.css`.
  - `apps/web/index.html` — Shell, lädt `src/main.tsx`. Fast nie ändern.
- **`apps/server/`** — Backend: `Bun.serve` + GraphQL Yoga + Pothos, Drizzle auf
  `bun:sqlite`. Schema/Resolver in `apps/server/src/graphql/`, DB in `apps/server/src/db/`.

## Regeln

- Frontend und Backend in ihren `src/`-Bäumen erweitern; **keine** eigenständige
  `*.html` anlegen.
- Nach dem Bauen `bun run typecheck` laufen lassen und Fehler beheben.
