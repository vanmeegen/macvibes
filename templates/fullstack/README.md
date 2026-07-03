# Fullstack (Bun + GraphQL + React)

Miniatur des macvibes-Stacks: `Bun.serve` mit GraphQL Yoga + Pothos und
Drizzle ORM auf `bun:sqlite` im Server, dazu ein React-+-MobX-Frontend mit
Vite. Beispiel-Domäne: Notizen anlegen und auflisten.

## Starten

```sh
bun install
bun run dev
```

- Frontend: <http://localhost:5173> (proxied `/graphql` an den Server)
- GraphQL-Server: <http://localhost:4000/graphql>

Die SQLite-Datenbank wird beim Start unter `apps/server/data/app.db` angelegt.

## Struktur

- `apps/server` — Bun.serve, GraphQL Yoga, Pothos-Schema, Drizzle ORM
- `apps/web` — React, MobX (`NotesStore` als Presentation Model), Vite

Weitere Befehle: `bun run typecheck`, `bun run build`.
