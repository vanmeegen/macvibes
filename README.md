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

bun run setup              # geführtes First-Run-Setup: Doctor, Anbieter-Wahl,
                           # Admin, .env, Baselines — empfohlen

# … oder manuell (Claude-Credentials für den Host-Proxy, verlassen den Host nie):
cp apps/server/.env.example apps/server/.env
#   → CLAUDE_CODE_OAUTH_TOKEN=... (via `claude setup-token`) oder ANTHROPIC_API_KEY

bun run baselines          # Template-Baseline-Snapshots bauen (nur mit msb)
bun run dev                # http://localhost:5173
```

Die `macvibes`-CLI klammert die Alltagsbefehle (`setup · start · stop · dev ·
doctor`, je `--help`): heute als `bun scripts/cli.ts <befehl>` bzw. nach
`bun link` (später Homebrew) als `macvibes <befehl>`. `bun run doctor` prüft
die Umgebung (bun, git, msb, Hypervisor, freie Ports), ohne etwas zu ändern.

Registrieren, dann von einem Admin freischalten lassen (der erste Nutzer der
Instanz wird automatisch Admin; ist `MACVIBES_ADMIN_USERNAME` gesetzt, gilt das
nur für diesen Namen). Danach Projekt aus einem Template anlegen, in den Chat
schreiben — Claude Code baut in einer eigenen MicroVM, die Preview läuft
daneben, jeder Turn wird automatisch committet.

Für den LAN-Betrieb (andere greifen über `http://<mac>.local:4000` zu):
`bun run start` (baut das Web-UI und lässt es vom Server ausliefern).

**Remote-/VPN-Zugriff (z. B. WireGuard):** Die Live-Preview läuft über ein
Gateway auf einem festen Port (`MACVIBES_PREVIEW_GATEWAY_PORT`, Default **4173**).
Damit die Preview von unterwegs sichtbar ist, muss neben der UI (5173 bzw. prod 4000) **einmalig auch Port 4173** im Router/WireGuard geforwardet werden — die
dynamischen VM-Ports müssen dann nicht mehr freigegeben werden.

## Andere Modelle (OpenRouter & Co.)

Neben Claude (Anthropic) und lokalen Ollama-Modellen lassen sich Anbieter wie
**OpenRouter** oder **OpenAI** einhängen. Das läuft **immer über den
mitgelieferten LiteLLM-Router** (`apps/server/local-router/`, Autostart), weil
der Credential-Proxy Anthropics `/v1/messages`-Format spricht: er hängt den
Request-Pfad an die Ziel-URL an und schickt Anthropic-JSON. OpenRouter und
OpenAI bieten aber **nur** einen OpenAI-kompatiblen Endpunkt
(`/chat/completions`) — eine rohe Anbieter-URL in `MACVIBES_MODEL_ROUTES`
funktioniert deshalb **nicht** (Format-Mismatch). Der LiteLLM-Router übersetzt
Anthropic↔OpenAI und liest den Anbieter-Key aus der Env.

`bun run setup` fragt OpenRouter/OpenAI direkt ab (setzt nur den Key). Manuell
in drei Schritten (Beispiel OpenRouter):

```bash
# 1) Key in apps/server/.env
OPENROUTER_API_KEY='sk-or-...'
```

```yaml
# 2) Modell im Router führen — apps/server/local-router/litellm_config.yaml
#    (ein Beispiel-Eintrag ist bereits aktiv; Slug von openrouter.ai anpassen).
#    Der model_name darf NICHT mit "claude" beginnen, sonst routet der Proxy ihn
#    an die Anthropic-API statt an den lokalen Router.
- model_name: openrouter/qwen/qwen3-coder
  litellm_params:
    model: openrouter/qwen/qwen3-coder
    api_key: os.environ/OPENROUTER_API_KEY
```

```ts
// 3) Modell im Chat-Dropdown wählbar machen —
//    apps/server/src/agent/agentModel.ts, exakt derselbe Name als id:
{ id: 'openrouter/qwen/qwen3-coder', label: 'Qwen3 Coder (OpenRouter)', slow: true },
```

Danach das Modell im Chat auswählen. Für OpenAI identisch mit
`OPENAI_API_KEY` und dem Präfix `openai/`. Ein **eigener** Endpunkt, der bereits
Anthropics `/v1/messages` spricht (z. B. ein selbst betriebener LiteLLM-Shim),
kann alternativ direkt über `MACVIBES_MODEL_ROUTES` eingehängt werden (siehe
`apps/server/.env.example`).

## HTTPS im LAN (Caddy — nötig für Mikrofon/Web Audio)

Browser geben Mikrofon, AudioWorklet & Co. nur in einem **Secure Context**
frei — im LAN heißt das HTTPS. Dafür terminiert ein
[Caddy](https://caddyserver.com) mit lokaler CA vor den unveränderten
http-Backends. **Caddy ist eine eigene Installations-Voraussetzung:**

```bash
brew install caddy

# ~/macvibes/Caddyfile anlegen (IP anpassen):
#   {
#     local_certs
#     storage file_system ~/macvibes/caddy-storage   # WICHTIG: sonst erzeugen
#   }                                                # verschiedene Startarten
#   https://<lan-ip>, https://localhost {            # unterschiedliche CAs!
#     reverse_proxy localhost:4000                   # Web/API (prod)
#   }
#   https://<lan-ip>:8443, https://localhost:8443 {
#     reverse_proxy localhost:4173                   # Preview-iframe
#   }
#   https://<lan-ip>:5443, https://localhost:5443 {
#     reverse_proxy localhost:5173                   # Dev-Modus (Vite)
#   }

cp ~/macvibes/Caddyfile /opt/homebrew/etc/Caddyfile
brew services start caddy   # Autostart beim Login
caddy trust                 # macOS der lokalen CA vertrauen (einmalig)

# In apps/server/.env:
#   MACVIBES_PREVIEW_GATEWAY_HTTPS_PORT=8443
```

Andere Geräte (z. B. iPad) müssen der CA einmalig vertrauen: das
Root-Zertifikat aus `~/macvibes/caddy-storage/pki/authorities/local/root.crt`
aufs Gerät bringen, Profil installieren und unter _Einstellungen → Allgemein →
Info → Zertifikatsvertrauen_ aktivieren. Danach `https://<lan-ip>` verwenden.
Ohne Caddy läuft macvibes unverändert über http — nur eben ohne
Mikrofon-/Audio-APIs auf Fremdgeräten.

## Diktieren (Mikro-Button im Chat)

Der Mikro-Button neben dem Eingabefeld nutzt **Chromes lokale On-Device-
Spracherkennung** (Web Speech API mit `processLocally`, Chrome/Chromium 139+):
Die Erkennung läuft komplett im Browser, nichts verlässt den Rechner, der
macvibes-Server ist nicht beteiligt. Tippen startet/stoppt die Aufnahme, der
erkannte Text landet im Eingabefeld; das DE/EN-Badge daneben schaltet die
Diktiersprache um (persistiert). Beim ersten Mal lädt Chrome das lokale
Sprachpaket selbst herunter.

- **Auf dem Mac:** funktioniert direkt unter `http://localhost:5173`.
- **Von anderen LAN-Geräten:** Browser geben das Mikrofon nur in sicheren
  Kontexten frei. Ohne HTTPS geht es trotzdem — auf dem Gerät einmalig
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure` auf
  `http://<mac-ip>:5173` setzen (Chromium-only).
- In nicht unterstützten Browsern/Kontexten ist der Button deaktiviert; der
  Tooltip erklärt die Ursache.

## Requirements

Die detaillierten Anforderungen mit Akzeptanzkriterien stehen in
[REQUIREMENTS.md](REQUIREMENTS.md), Architektur & Konventionen in
[CLAUDE.md](CLAUDE.md). Status: **Phase A + B + C umgesetzt** — Login,
Projekte, isolierte MicroVMs, Chat mit Claude Code (Credential-Proxy),
Live-Preview, Auto-Commit, Lifecycle, GitHub-Mirror, Mid-Turn-Steering.
