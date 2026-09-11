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

## Lokales Modell (oMLX + Qwen 3.8)

Neben den Claude-Modellen steht im Chat-Dropdown **`Qwen 3.8 27B (lokal, oMLX)`**
— ein Modell, das komplett auf dem Mac läuft. Es wird von
[oMLX](https://github.com/jundot/omlx) serviert, das Anthropics
`/v1/messages` **nativ** spricht (Streaming, Tool-Calls, Thinking). Der
Credential-Proxy schickt deshalb alle Nicht-Claude-Modelle ohne eigene Route
direkt an `MACVIBES_LOCAL_UPSTREAM_URL` (Default `http://localhost:8000`); ein
Übersetzer ist nicht nötig.

Einrichtung (einmalig, ~17 GB Download) über das Schwesterprojekt
[mac-local-coding-agent](https://github.com/vanmeegen/mac-local-coding-agent):

```bash
git clone https://github.com/vanmeegen/mac-local-coding-agent && cd mac-local-coding-agent
./setup.sh      # brew tap jundot/omlx, Modell nach ~/.omlx/models, Lightning MTP + 128K Kontext
```

Danach läuft oMLX als brew-Service (`omlx start|stop|restart`, Admin-UI
`http://localhost:8000/admin`). macvibes prüft beim Start `GET /health`; läuft
dort schon etwas, wird es benutzt, sonst startet macvibes `omlx serve` selbst
und überwacht es (`MACVIBES_LOCAL_ROUTER_CMD`, Log `~/macvibes/local-router.log`).
Gemessen auf einem M5 Pro 48 GB: ~31 tok/s Decode, Prefill 458 tok/s, und der
Prefix-Cache von oMLX macht Folge-Turns mit 20–30k Token Kontext in Sekunden
statt Minuten (`cache_read_input_tokens` ≈ 22k im zweiten Turn).

Der Katalogeintrag lebt in `apps/server/src/agent/agentModel.ts`; die id ist
exakt der Modellname, den oMLX unter `/v1/models` führt. Ein anderes
oMLX-Modell bekommt man ohne Codeänderung über `~/macvibes/models.json`
(`{"id":"<oMLX-Modellname>","label":"…","slow":true}`).

## Andere Modelle (OpenRouter & Co.)

Auch **jeder weitere Anbieter** lässt sich einhängen — OpenRouter, OpenAI oder
ein eigener Endpunkt. Der einfachste Weg ist `bun run setup`: dort gibt man für
einen eigenen Anbieter nur **Anzeigename, Basis-URL und Token** an. Das Setup
holt dann die **Modell-Liste des Anbieters** (`GET /models`, mit und ohne
`/v1`; OpenRouter, OpenAI und Anthropic antworten gleichförmig) und man wählt
daraus **beliebig viele Modelle** — per Suchbegriff und nummerierten Treffern
(`1,3,7` oder `alle`), in mehreren Suchdurchgängen; bei hunderten Modellen
(OpenRouter) wird nie die ganze Liste ausgekippt. Ist die Liste nicht
abrufbar, fällt das Setup auf die manuelle Eingabe kommagetrennter Modell-IDs
zurück. Modelle mit `claude`-Präfix sind reserviert und werden mit Hinweis
übersprungen.

Welches API-Format der Anbieter spricht, muss man **nicht wissen** — das
Setup schickt je eine Mini-Probe (`max_tokens: 1`, Timeout 10 s, mit dem
ersten gewählten Modell; das Format hängt am Endpunkt, nicht am Modell) an
Anthropics `/v1/messages` und OpenAIs `/chat/completions` (mit und ohne
`/v1`) und sagt im Klartext, was es gefunden hat:

- **Anthropic-kompatibel** → direkte Routen in `MACVIBES_MODEL_ROUTES` (ohne
  Übersetzer; **eine Route pro Modell** mit der exakten id als `prefix` — ein
  gemeinsamer, automatisch berechneter Präfix könnte fremde Modelle
  mit-matchen) + je Modell ein Eintrag in `~/macvibes/models.json`
  (Chat-Dropdown).
- **OpenAI-kompatibel** → läuft über die mitgelieferte **LiteLLM-Bridge**
  (s. u.): je Modell ein Alias in `~/macvibes/litellm.yaml`, der Key als
  `<ANZEIGENAME>_API_KEY` in der `.env`, je Modell eine Route auf die Bridge
  in `MACVIBES_MODEL_ROUTES` und ein Eintrag in `models.json`. Die erzeugte
  `litellm.yaml` enthält weiterhin den Basis-Eintrag (Qwen über oMLX) und den
  `'*'`-Catch-all als **letzten** Eintrag — auch nach beliebig vielen neuen
  Einträgen (ohne ihn brechen Claude Codes Hilfsmodell-Aufrufe).
- **Token abgelehnt (401/403)** → das ist **kein** Formatproblem; das Setup
  meldet es genau so und bietet einen neuen Versuch an.
- **Nicht erreichbar / kein Format** → klare Meldung, erneut versuchen oder
  überspringen — es wird nie halb konfiguriert.

### Die LiteLLM-Bridge

Hintergrund: der Credential-Proxy spricht Anthropics `/v1/messages`-Format
(er hängt den Request-Pfad an die Ziel-URL an). OpenRouter und OpenAI bieten
nur einen OpenAI-kompatiblen Endpunkt — eine rohe Anbieter-URL in
`MACVIBES_MODEL_ROUTES` scheitert dort am Format-Mismatch. Deshalb liegt in
`apps/server/local-router/` eine [LiteLLM](https://docs.litellm.ai)-Bridge:
sie nimmt Anthropic-Format auf `http://localhost:8787/v1/messages` entgegen
und übersetzt (inkl. Streaming + Tool-Calling) auf die OpenAI-kompatiblen
Anbieter aus ihrer Config.

- **Start:** automatisch mit `bun run dev`/`start`, sobald
  `~/macvibes/litellm.yaml` existiert (legt `bun run setup` an) oder
  `MACVIBES_LITELLM_AUTOSTART=1` gesetzt ist; manuell `bun run router`. Beim
  allerersten Start legt sie ihre Python-venv unter
  `~/macvibes/local-router-venv` an (1–2 min). Log: `~/macvibes/litellm.log`.
  Health: `http://localhost:8787/health/liveliness`.
- **Config:** existiert `~/macvibes/litellm.yaml`, nutzt die Bridge NUR sie
  (upgrade-fest; abweichender Pfad über `MACVIBES_LOCAL_ROUTER_CONFIG`), sonst
  die mitgelieferte `litellm_config.yaml`.
- **Das lokale Qwen-Modell ist auch über die Bridge erreichbar** (Alias
  `Qwen3.8-27B-oQ4e-mtp` auf oMLX' OpenAI-Endpunkt `http://localhost:8000/v1`)
  — für Tools, die zwingend mit LiteLLM reden sollen. Der Agent selbst geht
  direkt zu oMLX.

Alle Konfigurationsorte sind **nutzereigene Dateien unter `~/macvibes`**
(bzw. `MACVIBES_HOME`) — Quellcode muss dafür nicht angefasst werden, und bei
einer Installation (Homebrew) überleben nur diese Dateien ein Upgrade (der
Installationsbaum in `libexec` wird bei jedem `brew upgrade` ersetzt).

Manuell geht es weiterhin in vier Schritten (Beispiel OpenRouter,
OpenAI-kompatibel):

```bash
# 1) Key in apps/server/.env (Repo-Betrieb) bzw. ~/macvibes/.env (Installation)
OPENROUTER_API_KEY='sk-or-...'
# 2) Route auf die Bridge (Proxy → LiteLLM :8787), exakte Modell-id als prefix
MACVIBES_MODEL_ROUTES='[{"prefix":"openrouter/qwen/qwen3-coder","upstreamUrl":"http://localhost:8787","apiKey":"local"}]'
```

```yaml
# 3) Modell in der Bridge führen — ~/macvibes/litellm.yaml
#    Beim ersten Mal die mitgelieferte apps/server/local-router/litellm_config.yaml
#    dorthin kopieren (existiert ~/macvibes/litellm.yaml, nutzt die Bridge NUR
#    noch sie). Der model_name darf NICHT mit "claude" beginnen, sonst routet
#    der Proxy ihn an die Anthropic-API.
- model_name: openrouter/qwen/qwen3-coder
  litellm_params:
    model: openrouter/qwen/qwen3-coder
    api_key: os.environ/OPENROUTER_API_KEY
```

```json
// 4) Modell im Chat-Dropdown wählbar machen — ~/macvibes/models.json,
//    ein JSON-Array, exakt derselbe Name als "id" ("slow": true empfohlen,
//    großzügige Timeouts). Kaputte Einträge werden beim Start nur gewarnt.
[{ "id": "openrouter/qwen/qwen3-coder", "label": "Qwen3 Coder (OpenRouter)", "slow": true }]
```

Danach den Server neu starten und das Modell im Chat auswählen. Für OpenAI identisch mit
`OPENAI_API_KEY` und dem Präfix `openai/`. Ein **eigener** Endpunkt, der bereits
Anthropics `/v1/messages` spricht, kann direkt über `MACVIBES_MODEL_ROUTES`
eingehängt werden (siehe `apps/server/.env.example`).

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
