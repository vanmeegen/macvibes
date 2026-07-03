# macvibes

Lokale Vibe-Coding-Plattform für den Mac: startet Claude-Code-Sessions in
isolierten Micro-Sandbox-Containern — leichtgewichtig, komplett lokal,
alles TypeScript auf Bun.

## Vision

- Pro Vibe-Coding-Session wird ein eigener Sandbox-Container hochgefahren,
  in dem Claude Code autonom und gefahrlos arbeiten kann.
- Eine schlanke Web-Oberfläche verwaltet Sessions: anlegen, beobachten,
  fortsetzen, beenden.
- Session-Metadaten und Historie liegen in einer eingebetteten Datenbank
  (SQLite) — kein externer Dienst nötig.

## Tech-Stack

Übernommen aus `behandlungsverwaltung`:

| Bereich   | Technologie                                                   |
| --------- | ------------------------------------------------------------- |
| Runtime   | Bun (Workspaces-Monorepo, `bun test`)                          |
| Sprache   | TypeScript, strict (ES2022, `noUncheckedIndexedAccess` & Co.)  |
| Backend   | `Bun.serve` + GraphQL Yoga + Pothos                            |
| Datenbank | `bun:sqlite` + Drizzle ORM (Migrationen: drizzle-kit)          |
| Frontend  | React 18 + MobX + MUI v5, gebaut mit Vite                      |
| Tests     | `bun test` (Server/Shared), Vitest (Web), Playwright (E2E)     |
| Qualität  | ESLint 9 (flat config), Prettier, Husky + lint-staged          |
| Sandbox   | microsandbox (self-hosted MicroVMs)                            |

## Struktur (geplant)

```
apps/
  web/      React + MobX Frontend (Session-Verwaltung)
  server/   Bun.serve + GraphQL, Session- & Container-Orchestrierung
packages/
  shared/   Typen, Zod-Validierung, Domain-Logik
```

## Konventionen

- Presentation-Model-Pattern: UI-Komponenten logikfrei, Logik in MobX-Stores.
- API ausschließlich GraphQL, kein REST.
- Strikte Typen, keine verschluckten Exceptions, TDD.
- Vor jedem Commit: `bun run ci`.

## Requirements

Die detaillierten Anforderungen mit Akzeptanzkriterien stehen in
[REQUIREMENTS.md](REQUIREMENTS.md). Kernkonzepte: **Projekte** (ein Branch
pro Projekt im Repo `macvibes-apps`), Templates aus `templates/`
(u. a. `pwa` und `fullstack`), Chat-Page mit Live-Preview (Lovable-artig),
Auto-Commit nach jedem Agent-Turn, Sandbox-Stopp nach 15 min Inaktivität.

## Nächste Schritte

1. ~~Requirements-Dokument (`REQUIREMENTS.md`) erarbeiten.~~ ✅
2. Monorepo-Gerüst nach obigem Stack aufsetzen.
3. Vertikaler Durchstich: Projekt anlegen, Sandbox starten, Chat + Preview sehen.
