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
    Template-Snapshots ein, `portService` mappt Preview-Ports.
    `vmServices` erzeugt die In-VM-Supervisor-Konfiguration (tini + monit),
    `monitStatus`/`previewStatusPoller` lesen den Preview-Status aus der
    monit-HTTP-API. (`previewSupervisor` lebt nur noch im `ProcessSandboxProvider`.)

  **Sandbox-/Preview-Schnittstelle (sauber gekapselt):** PID 1 der MicroVM ist
  ein **In-VM-Supervisor** (`tini -s` als Reaper + `monit`, Konfiguration aus
  `vmServices.ts`), der **zwei Services** startet, überwacht und bei Crash neu
  startet: den **Dev-Server** und den **Agent-Daemon**. Kein host-seitiger
  Watchdog, kein `msb exec` im Agent-Pfad. monit macht die geduldige
  **Startphase** (Port-Health-Check erst nach `30 cycles`), **Crash-Recovery**
  (Neustart) und **Crash-Loop-Schutz** (`5 restarts within 40 cycles →
unmonitor` ≙ `failed`). Der Host **liest** den Status nur: über die
  monit-HTTP-API (auf `127.0.0.1` gemappt) plus eine HTTP-Probe auf den
  Preview-Port — `ready` gilt erst, wenn der Dev-Server wirklich HTTP
  beantwortet (monit sieht nur den Prozess). Der einzige Vertrag zum Template
  ist `devCommand` + `previewPort` + PORT-Env aus `templates.json` — kein
  template-spezifischer Code in der Plattform. Der Preview-Status
  (`starting`/`ready`/`restarting`/`failed`/`stopped`) fließt über GraphQL
  (`Project.previewStatus`) ins UI-Overlay.

  **Preview-Gateway (`http/previewGateway.ts`):** Jede Preview läuft auf einem
  dynamisch allokierten hohen VM-Port — für Remote-/VPN-Zugriff nicht
  erreichbar (der Tunnel reicht nur bekannte feste Ports durch). Deshalb
  reverse-proxied ein **Gateway auf einem festen Port** (`MACVIBES_PREVIEW_GATEWAY_PORT`,
  Default 4173) alle Previews. Die iframe-URL ist `http://<host>:4173/p/<projectId>/`;
  das Gateway routet per **Referer** (parallelfest), sonst **Cookie**, zur
  richtigen VM (HTTP + HMR-WebSocket). Die Preview behält ihre eigene Origin →
  keine kaputten absoluten Asset-Pfade, kein Template-Eingriff. Für Remote muss
  nur dieser eine Port geforwardet werden.

  **Agent-Transport (Daemon in der VM):** Der Agent-Daemon (`agent/daemon/`,
  gebündelt und ro in die VM gemountet) hält **eine langlebige Agent-SDK-
  `query()`** im Streaming-Input-Modus (Konversationszustand lebt im Prozess,
  kein `--resume` pro Turn). Er **wählt sich ausgehend** über
  `host.microsandbox.internal` ins Host-`AgentGateway` (WebSocket, Token-Auth
  wie der Credential-Proxy) — kein Port-Forwarding in die VM. Turn-Kommandos
  gehen über die stehende Verbindung; Abbruch ist ein sauberer SDK-`interrupt()`
  (kein Prozess-Kill, Session bleibt intakt). Ein `turn-started`-ACK +
  Ping/Pong-Heartbeat härten gegen msb-NAT (verschluckt FIN/RST).
  - `agent/` — `AgentRunner`-Interface: `DaemonAgentRunner` (VM-Daemon über das
    WS-Gateway, der Produktivpfad), `ClaudeAgentRunner` (Host, Dev ohne msb),
    `FakeAgentRunner` (Tests). `agent/daemon/` ist der In-VM-Daemon,
    `agentGateway` die Host-Gegenstelle, `claudeStreamJson`
    (`agentEventsFromMessage`) mappt SDK-Messages auf `AgentEvent`s.
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
Template-Baseline-Snapshot (bootet unter tini+monit) → der Agent-Daemon in der
VM wählt sich ins Host-Gateway ein → Agent (Claude Code via Agent SDK) arbeitet
in der VM, API über den Host-Proxy → jeder Turn wird auto-committet → optional
GitHub-Mirror.

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
bun run dev                # Web (5173, MACVIBES_WEB_PORT) + Server (4000, PORT) parallel, Dev-Modus
bun run ci                 # lint + typecheck + alle Unit-/Integrationstests
bun --filter='@macvibes/web' run e2e   # Playwright-E2E (nutzt Prozess-Provider + Fake-Agent)
bun --filter='@macvibes/web' run e2e:live  # Live-Walkthrough gegen LAUFENDEN Server (echte VMs + Claude; braucht freigeschalteten Nutzer browsertest, s. e2e-live/)
bun run baselines          # Template-Baseline-Snapshots (neu) bauen — nach Template-Änderungen
bun run start              # Produktion: Web bauen + Server (liefert dist aus, LAN)
```

## Sandbox / VM (microsandbox)

- **Bun ist auf 1.3.14 gepinnt** (Host via `brew pin bun`, VM-Image
  `oven/bun:1.3.14` in `config.ts`, `@types/bun` exakt in allen Manifesten):
  das nächste große Bun ist ein Rust-Rewrite — NICHT upgraden ohne intensiven
  Test aller Sandbox-/Agent-Pfade.
- `msb` muss installiert sein (`brew install superradcompany/tap/microsandbox`).
  Ohne `msb` fällt der Server automatisch auf den Prozess-Provider zurück
  (kein VM-Isolat — nur Dev). Erzwingen: `MACVIBES_SANDBOX=microsandbox|process`.
- **Dependencies überleben VM-Neustarts per Delta-Install (ADR 0002):**
  `node_modules` ist ein Symlink in den ephemeren Snapshot-Fork; ein `bun add`
  des Agenten landet nur in `bun.lock` (persistent, auto-committet). Beim
  Dev-Server-Start zieht `devserver-run.sh` das Delta per `bun install` nach
  (No-Op ~17 ms), gespeist aus dem persistenten Bun-Cache auf dem
  Projekt-Volume (`bun-cache`, gemountet als `/bun-cache`).
- **Baselines sind Pflicht** und nach jeder Template-Änderung neu bauen
  (`bun run baselines`): eine Builder-VM installiert `bun install`, das
  **Agent SDK** (`/opt/macvibes`) und **tini + monit** (In-VM-Supervisor) und
  friert das als `macvibes-tpl-<dir>`-Snapshot ein. Neue Projekte forken diesen
  Snapshot (Preview in ~2 s statt Install zur Laufzeit) — **ohne Baseline
  bootet keine Projekt-VM** (der Provider meldet das als klaren Fehler).
- VM-Netz: nur `allow@public` (bun/npm) + `allow@172.16.0.0/12` (Host-Gateway
  `host.microsandbox.internal` für den Credential-Proxy).

## HTTPS im LAN (Caddy, lokale CA)

Mikrofon/AudioWorklet & Co. brauchen einen Secure Context — im LAN heißt das
HTTPS. TLS terminiert ein **Caddy** vor den unveränderten http-Backends
(`~/macvibes/Caddyfile`, `local_certs`): `:443 → 4000` (Web/API inkl.
Gateway-WebSockets) und `:8443 → 4173` (Preview-iframe). Die VM-interne
Kommunikation (Agent-Daemon, Credential-/Egress-Proxy) bleibt bewusst http.
`MACVIBES_PREVIEW_GATEWAY_HTTPS_PORT` (hier 8443) sagt dem Frontend, dass es
die iframe-URL auf einer HTTPS-Seite über diesen Port bauen muss (sonst Mixed
Content). Start: `caddy start --config ~/macvibes/Caddyfile`. Geräte müssen
der lokalen CA einmalig vertrauen: Mac `caddy trust`; iPad das Root-Zertifikat
(`~/Library/Application Support/Caddy/pki/authorities/local/root.crt`)
installieren + unter Zertifikatsvertrauen aktivieren.

## Credentials

Der Agent in der VM erreicht die Claude API nur über den Host-Proxy. In
`apps/server/.env` (siehe `.env.example`, ist gitignored):

- `CLAUDE_CODE_OAUTH_TOKEN` (via `claude setup-token`) — bevorzugt, oder
- `ANTHROPIC_API_KEY`.

Der Token verlässt den Host nie und landet nie in einer Sandbox.
