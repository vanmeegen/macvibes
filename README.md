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
| Runtime   | Bun (Workspaces-Monorepo, `bun test`)                         |
| Sprache   | TypeScript, strict (ES2022, `noUncheckedIndexedAccess` & Co.) |
| Backend   | `Bun.serve` + GraphQL Yoga + Pothos                           |
| Datenbank | `bun:sqlite` + Drizzle ORM (Migrationen: drizzle-kit)         |
| Frontend  | React 18 + MobX + MUI v5, gebaut mit Vite                     |
| Tests     | `bun test` (Server/Shared), Vitest (Web), Playwright (E2E)    |
| Qualität  | ESLint 9 (flat config), Prettier, Husky + lint-staged         |
| Sandbox   | microsandbox (self-hosted MicroVMs)                           |

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

## Schnellstart

Voraussetzungen: [Bun](https://bun.sh), git und — für echte VM-Isolation —
[microsandbox](https://microsandbox.dev)
(`brew install superradcompany/tap/microsandbox`, Apple Silicon). Ohne `msb`
läuft alles trotzdem, dann aber ohne VM-Isolat (Prozess-Provider).

```bash
bun install

# Claude-Credentials für den Host-Proxy (verlassen den Host nie):
cp apps/server/.env.example apps/server/.env
#   → CLAUDE_CODE_OAUTH_TOKEN=... (via `claude setup-token`) oder ANTHROPIC_API_KEY

bun run baselines          # Template-Baseline-Snapshots bauen (nur mit msb)
bun run dev                # http://localhost:5173
```

Registrieren mit dem Invite-Code (Default `macvibes`, setzbar über
`MACVIBES_INVITE_CODE`), Projekt aus einem Template anlegen, in den Chat
schreiben — Claude Code baut in einer eigenen MicroVM, die Preview läuft
daneben, jeder Turn wird automatisch committet.

Für den LAN-Betrieb (andere greifen über `http://<mac>.local:4000` zu):
`bun run start` (baut das Web-UI und lässt es vom Server ausliefern).

**Remote-/VPN-Zugriff (z. B. WireGuard):** Die Live-Preview läuft über ein
Gateway auf einem festen Port (`MACVIBES_PREVIEW_GATEWAY_PORT`, Default **4173**).
Damit die Preview von unterwegs sichtbar ist, muss neben der UI (5173 bzw. prod 4000) **einmalig auch Port 4173** im Router/WireGuard geforwardet werden — die
dynamischen VM-Ports müssen dann nicht mehr freigegeben werden.

## Requirements

Die detaillierten Anforderungen mit Akzeptanzkriterien stehen in
[REQUIREMENTS.md](REQUIREMENTS.md), Architektur & Konventionen in
[CLAUDE.md](CLAUDE.md). Status: **Phase A + B + C umgesetzt** — Login,
Projekte, isolierte MicroVMs, Chat mit Claude Code (Credential-Proxy),
Live-Preview, Auto-Commit, Lifecycle, GitHub-Mirror, Mid-Turn-Steering.
