# Projekt-Kontext für den Agenten (macvibes · Client-PWA)

Dies ist eine **React-PWA** mit Bun-nativer Toolchain — **Bun.serve mit HMR, kein
Vite, kein Bundler**. Der Dev-Server läuft in dieser Umgebung **bereits**
(`bun run dev` → `server.ts`, Port aus `PORT`) und liefert die App aus; jede
Änderung an einer Quelldatei erscheint per HMR **sofort in der Live-Preview**.

## So ist die App aufgebaut (hier bearbeiten — KEINE eigene HTML-Datei anlegen)

- `index.html` — nur die Shell: `<div id="root">` + lädt `src/main.tsx`. Fast nie ändern.
- `src/main.tsx` — mountet `<App/>` in `#root` und importiert `styles.css`. Selten ändern.
- **`src/App.tsx` — die Wurzel-Komponente. HIER die App aufbauen** bzw. deine
  Komponenten einhängen. Nur was von `App.tsx` gerendert wird, ist in der Preview sichtbar.
- `src/components/` — React-Komponenten (`.tsx`).
- `src/models/` — MobX-Stores. **Wichtig:** `makeAutoObservable(this)` verträgt **keine
  Vererbung** — jeder Store ist eine eigenständige Klasse ohne `extends`. Komponenten,
  die Store-State lesen, in `observer(...)` aus `mobx-react-lite` wickeln.
- `src/styles.css` — globale Styles.

## Regeln

- Baue in die **bestehende React-Struktur** ein (neue Dateien unter `src/…`), lege
  **keine** eigenständige `*.html` neben `index.html` an — die wird nicht ausgeliefert.
- Verfügbare Libs: React 18, MobX + mobx-react-lite, Recharts (Charts), xlsx (Excel).
- Nach dem Bauen kurz `bun run typecheck` laufen lassen und Fehler beheben.
- Dateien mit **relativen Pfaden** im Projektverzeichnis anlegen (nicht nach `/home/...`).
