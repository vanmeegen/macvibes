# CLAUDE.md

Leitfaden für Agenten, die an **macvibes** arbeiten — einer lokalen
Vibe-Coding-Plattform: Claude-Code-Sessions laufen isoliert in
microsandbox-MicroVMs, mit Chat-Interface und Live-Preview (Lovable-artig).

Requirements mit Akzeptanzkriterien: [`REQUIREMENTS.md`](REQUIREMENTS.md).

## Architektur

Bun-Workspaces-Monorepo:

- **`apps/server`** — `Bun.serve` + GraphQL Yoga + Pothos, Drizzle auf
  `bun:sqlite`. Kern:
  - `sandbox/` — `SandboxManager` (Lifecycle: Grace/Idle/LRU), `SandboxProvider`
    (Interface) mit `ProcessSandboxProvider` (Host, für Dev/Tests) und
    `MicrosandboxSandboxProvider` (echte MicroVMs). `baselineService` friert
    Template-Snapshots ein, `portService` mappt Preview-Ports,
    `previewSupervisor` ist der host-seitige Watchdog für den Dev-Server.

  **Sandbox-/Preview-Schnittstelle (sauber gekapselt):** Die MicroVM läuft als
  **stabiler Halter** (`sleep infinity` als PID 1) und überlebt einen
  Dev-Server-Crash — der Agent (per `msb exec`) verliert seine Umgebung nicht.
  Der Preview-/Dev-Server wird vom host-seitigen `PreviewSupervisor` per
  `msb exec` gestartet und überwacht: geduldige **Startphase** (Status
  `starting`, kein voreiliger Neustart, während der Server hochfährt),
  **Laufphase** mit Health-Check und Crash-Recovery (Neustart mit Backoff),
  **Crash-Loop-Schutz** (nach `maxRestarts` → `failed`). Der einzige Vertrag
  zum Template ist `devCommand` + `previewPort` + PORT-Env aus `templates.json`
  — kein template-spezifischer Code in der Plattform. Der Preview-Status
  (`starting`/`ready`/`restarting`/`failed`/`stopped`) fließt über GraphQL
  (`Project.previewStatus`) ins UI-Overlay.
  - `agent/` — `AgentRunner`-Interface: `ClaudeAgentRunner` (Host),
    `VmAgentRunner` (`msb exec` in der VM), `FakeAgentRunner` (Tests).
    `claudeStreamJson` parst die CLI-Ausgabe.
  - `services/` — `chatService` (Turn-Queue, Streaming, Historie, Steering),
    `projectsService`, `gitService` (Orphan-Branch pro Projekt im Bare-Repo),
    `workspaceService`, `authService`, `autoCommitService`, `mirrorService`.
  - `http/anthropicProxy` — Credential-Proxy: die VM sieht nie einen Token.

- **`apps/web`** — React 18 + MobX + MUI, Vite. Presentation-Model-Pattern.
- **`packages/shared`** — Zod-Schemas, Branch-Slugify (Zod v4).
- **`templates/`** — Projekt-Vorlagen (NICHT Teil der Workspaces), dynamisch
  aus `templates.json` gelesen. `pwa` ist Bun-nativ (kein Vite), `fullstack`
  spiegelt den macvibes-Stack.

Datenfluss: Projekt anlegen → Orphan-Branch `<user>/<slug>` im lokalen
Bare-Repo `~/macvibes/macvibes-apps.git` → beim Öffnen forkt die VM den
Template-Baseline-Snapshot → Agent (Claude Code) arbeitet in der VM, API über
den Host-Proxy → jeder Turn wird auto-committet → optional GitHub-Mirror.

## Konventionen (verbindlich)

- **TDD, test-first:** Erst der fehlschlagende Test (Assertions rot, Code
  kompiliert — also Stubs mit Default-Rückgaben), dann die Implementierung,
  dann grün. Akzeptanzkriterien aus dem PRD als Playwright-E2E.
- **Presentation-Model:** UI-Komponenten logikfrei, alle Logik in MobX-Stores;
  `observer` statt React-State-Hooks für Logik.
- **API ausschließlich GraphQL**, kein REST (Ausnahme: der Anthropic-Proxy).
- **Strikte Typen** (siehe `tsconfig.base.json`), keine verschluckten
  Exceptions — jeder `catch` loggt / meldet / gibt ein Result zurück.
- **Selektion in E2E nur über `data-testselector`**, nie über übersetzte Strings.
- **Vor jedem Commit `bun run ci`** (lint + typecheck + test). Nach jedem
  fertigen, grünen Teil committen (deutsche, aussagekräftige Message).

## Befehle

```bash
bun install                # Dependencies
bun run dev                # Web (5173) + Server (4000) parallel, Dev-Modus
bun run ci                 # lint + typecheck + alle Unit-/Integrationstests
bun --filter='@macvibes/web' run e2e   # Playwright-E2E (nutzt Prozess-Provider + Fake-Agent)
bun run baselines          # Template-Baseline-Snapshots (neu) bauen — nach Template-Änderungen
bun run start              # Produktion: Web bauen + Server (liefert dist aus, LAN)
```

## Sandbox / VM (microsandbox)

- `msb` muss installiert sein (`brew install superradcompany/tap/microsandbox`).
  Ohne `msb` fällt der Server automatisch auf den Prozess-Provider zurück
  (kein VM-Isolat — nur Dev). Erzwingen: `MACVIBES_SANDBOX=microsandbox|process`.
- **Baselines nach jeder Template-Änderung neu bauen** (`bun run baselines`):
  installiert `bun install` + Claude Code global in einer Builder-VM und friert
  sie als `macvibes-tpl-<dir>`-Snapshot ein. Neue Projekte forken diesen
  Snapshot (Preview in ~2 s statt Install zur Laufzeit).
- VM-Netz: nur `allow@public` (bun/npm) + `allow@172.16.0.0/12` (Host-Gateway
  `host.microsandbox.internal` für den Credential-Proxy).

## Credentials

Der Agent in der VM erreicht die Claude API nur über den Host-Proxy. In
`apps/server/.env` (siehe `.env.example`, ist gitignored):

- `CLAUDE_CODE_OAUTH_TOKEN` (via `claude setup-token`) — bevorzugt, oder
- `ANTHROPIC_API_KEY`.

Der Token verlässt den Host nie und landet nie in einer Sandbox.
