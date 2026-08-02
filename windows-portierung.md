# macvibes unter Windows: Machbarkeitsanalyse (Stand 2026-08-02)

Ersetzt den Stand vom 2026-07-24. Seitdem geändert: msb wird nicht mehr über
die CLI, sondern **in-process über das SDK** angesprochen (`msbClient.ts`);
die Basisschicht `core/` existiert (gitService/workspaceService/processSupervisor
liegen dort); und die Host-Inventur wurde vollständig neu erhoben.

## Kurzfazit

**Technisch machbar — ohne WSL2.** microsandbox unterstützt Windows nativ über
die **Windows Hypervisor Platform (WHP)** seit v0.6.0 (27.06.2026); die von
macvibes gepinnte **v0.6.8 (29.07.2026) ist zugleich die aktuellste Version**
(Re-Check 2026-08-02) und liefert die Windows-DLLs
(`libkrunfw-windows-{x86_64,aarch64}.dll`) sowie die npm-Plattformpakete
`@superradcompany/microsandbox-win32-{x64,arm64}-msvc` mit. Der Host-Code-Aufwand
ist klein und klar umrissen (~2–4 Tage); das Risiko liegt fast vollständig im
Reifegrad des msb-Windows-Supports: Das npm-README nennt ihn ausdrücklich
**„preview"**, das Projekt insgesamt „beta software". Windows-Support ist zum
Analysezeitpunkt ~5 Wochen alt.

Zwei entlastende Befunde bleiben gültig:

1. **Issue #47 („Windows Support without WSL") ist via PR #1019 geschlossen**;
   libkrun läuft auf WHP — ausdrücklich NICHT `VirtualMachinePlatform`
   (das ist WSL2/Docker Desktop). v0.6.1 ergänzte Bind-Mounts und deklariert
   **VCRedist 2015+** als Abhängigkeit.
2. **Der gesamte Unix-Kram im Gast bleibt Linux.** `#!/bin/sh`-Skripte, `tini`,
   `monit`, `setsid`, `kill -TERM -- -PID`, der `ln -s`-Bootstrap für
   `node_modules` (ADR 0002) — alles läuft **in** der Linux-VM (String-Building
   auf dem Host, Ausführung im Gast) und muss nicht portiert werden.

## Aufwandsschätzung

| Stufe                                        | Aufwand   | Risiko                          |
| -------------------------------------------- | --------- | ------------------------------- |
| **0 — Validierungs-Spike** (msb auf Windows) | 1–2 Tage  | entscheidet über alles          |
| **1 — Host-Code entunixen** (Dev ohne VM)    | 2–4 Tage  | gering, mechanisch              |
| **2 — VM-Parität** (falls Spike trägt)       | 2–5 Tage  | mittel, überwiegend Fremdcode   |
| CI-Matrix macos + windows (Voraussetzung!)   | 0,5–1 Tag | gering                          |
| **Alternativ: alles in WSL2**                | 1–2 Tage  | niedrig, „Linux in Verkleidung" |

⚠️ **Stufe 1 allein ist kein auslieferbarer Zustand** — siehe Sicherheitshinweis
unten. Laufender Mehraufwand nicht vergessen: eine zweite Plattform verdoppelt
die Test-Matrix; ohne Windows-CI (oder regelmäßige manuelle Läufe) erodiert der
Support sofort.

## Stufe 0 — Validierungs-Spike (billigster Erkenntnisgewinn)

Kein Code, ein Experiment auf einem **Windows-11**-Rechner:

1. WHP aktivieren (`HypervisorPlatform`, nicht `VirtualMachinePlatform`);
   Virtualisierung im UEFI; VCRedist 2015+; `msb doctor --fix` hilft.
2. microsandbox 0.6.8 installieren (`irm https://install.microsandbox.dev/windows | iex`
   bzw. npm-Paket mit win32-Plattformpaket).
3. Eine VM starten mit genau den vier Dingen, an denen es scheitern würde:
   - **Bind-Mount mit Laufwerksbuchstaben** (`C:\…` — unser SDK-Pfad
     `.volume(b => b.bind(realpathSync(host)))` in `msbClient.ts:286-292` ist
     unter Windows ungeprüft; `realpathSync` liefert dort `C:\…`-Pfade),
   - **Port-Publishing an 127.0.0.1** (`.portBind`, `msbClient.ts:279-282`;
     Defender-Firewall-Abfrage beim ersten Publish),
   - **`host.microsandbox.internal`** aus der VM heraus erreichbar — daran hängt
     der KOMPLETTE Agent-Transport (Daemon-Dial-out `index.ts:185`,
     Credential-/Egress-Proxy `agent/vmAgentEnv.ts:29,34-36`). Ohne diesen Namen
     läuft kein einziger Agent-Turn.
   - **Snapshots** (`Snapshot.builder().fromSandbox()` — Baseline-Bau
     `baselineService.ts` inkl. `apt-get` in der Builder-VM unter WHP).
4. Trägt das, ist der Rest Fleißarbeit (Stufen 1–2). Trägt es nicht → WSL2-Weg.

## Stufe 1 — Host-Code entunixen

Vollständige Inventur 2026-08-02 (Explore über apps/server/src, scripts/,
package.json, local-router):

| Stelle                                              | Problem                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/sandbox/processProvider.ts:48`     | `Bun.spawn(['sh','-c', \`exec ${devCommand}\`])`— kein`sh` unter Windows. **Das ist der Fallback-Provider, also genau der Pfad ohne VM.** Sonst ist der ProcessProvider fast Windows-tauglich.                                                                                             |
| `apps/server/src/sandbox/processProvider.ts:56`     | `proc.kill('SIGTERM')` — kein SIGTERM/keine Prozessgruppen unter Windows → Kindprozesse des Dev-Servers verwaisen. Braucht `taskkill /T` oder Job Objects. Gleiches Muster: `core/processSupervisor.ts`.                                                                                   |
| `apps/server/src/sandbox/processProvider.ts:64`     | `httpProbe('http://localhost:<port>/')` — Windows löst `localhost` bevorzugt `::1`, Dev-Server bindet IPv4 → Probe schlägt fehl, Preview nie `ready`. Fix: `127.0.0.1`. Gleiches im VM-Daemon (`agent/daemon/main.ts:102`) betrifft nur den Gast (Linux) — dort ok.                        |
| `apps/server/src/core/gitService.ts:36-37,75-84`    | **git-Härtung mit `/dev/null` und `/bin/false`** (`GIT_CONFIG_GLOBAL`, `GIT_ASKPASS`, `core.hooksPath`, `core.attributesFile`) — existieren unter Windows nicht. Fix: `NUL` bzw. portable Askpass-Neutralisierung. Zentral: läuft in JEDEM git-Aufruf.                                     |
| `apps/server/src/db/client.ts:12,23,30,34`          | `mkdirSync({mode:0o700})`/`chmodSync 0o600` auf DB-Verzeichnis + app.db/-wal/-shm — **POSIX-Modes unter NTFS wirkungslos**, Sicherheitsannahme F25 greift nicht. Braucht ACL-Äquivalent (`icacls`) oder dokumentierte Abschwächung — Sicherheitsentscheidung, kein reiner Code-Fix.        |
| `apps/server/src/index.ts:117-120`                  | `.env`-Rechte-Check `mode & 0o077` (F26) + `chmod 600`-Hinweis — unter Windows bedeutungslos; Check plattformabhängig machen.                                                                                                                                                              |
| `apps/server/src/services/localRouterService.ts:78` | `sh -c` + `>> log 2>&1`-Redirect statt stdout-Datei-Handle.                                                                                                                                                                                                                                |
| `apps/server/local-router/run.sh`                   | bash, `set -euo pipefail`, `"$VENV/bin/litellm"` (Windows: `Scripts\litellm.exe`), `$HOME`. Am besten durch `run.ts` (Bun) ersetzen — dann entfällt auch das `sh -c`. `config.ts:139-143` zeigt fest auf den `.sh`-Pfad. Alternativ: lokale Modelle als „nicht unter Windows" deklarieren. |
| `scripts/preflight.sh`, `scripts/shutdown.sh`       | `bash`, `lsof`, `pkill`, `awk`, `xargs kill`, `sed`, `sleep`; shutdown.sh ruft zusätzlich die **msb-CLI** (`msb list/stop`, Z. 79-105) für verwaiste VMs. Als plattformneutrale Bun-TS-Skripte neu schreiben (wird auch auf dem Mac robuster). `package.json:20-21` ruft `bash` direkt.    |
| `package.json` (mehrere Scripts)                    | `--filter='*'`-Single-Quotes überleben cmd/PowerShell nicht; `cd apps/… &&`-Ketten brauchen POSIX-Shell. Doppelquotes bzw. Bun-Scripts.                                                                                                                                                    |
| Repo-Root                                           | **Keine `.gitattributes`** (verifiziert 2026-08-02)! Windows-Default `core.autocrlf=true` → CRLF überall → Prettier/lint-staged schlagen fehl, Shebangs der Gast-Skripte brechen in der Linux-VM. Fix: `* text=auto eol=lf`.                                                               |
| `.husky/`-Hooks                                     | `#!/usr/bin/env sh`-Wrapper — läuft unter Git-Bash (Git für Windows), sonst nicht.                                                                                                                                                                                                         |
| `apps/web/e2e/templates.spec.ts:52,62`              | `detached: true` + `process.kill(-pid)` — negative PIDs gibt es unter Windows nicht (verifiziert, noch vorhanden).                                                                                                                                                                         |
| `apps/web/e2e/preview-responsive.spec.ts:5-6`       | Hart kodierter absoluter Screenshot-Pfad (`/private/tmp/claude-501/…`) — bricht auf jedem fremden Rechner. Eigentlich ein Bug, unabhängig von Windows.                                                                                                                                     |

**Portierungsfreundlich (verifiziert):** durchgängig `node:path`
(`join`/`resolve`, keine hartkodierten Trenner im Host-Code), `homedir()`,
`bun:sqlite` (eingebaut), **keine Unix-Domain-Sockets** — alle IPC über
TCP/HTTP/WebSocket.

## Stufe 2 — VM-Parität

Seit dem SDK-Umstieg (v0.6.6+) läuft die gesamte msb-Anbindung durch **eine**
Datei: `apps/server/src/sandbox/msbClient.ts` (napi-Addon in-process, kein
CLI-Spawn im Produktivpfad). Das verkleinert Stufe 2 gegenüber der alten
Analyse deutlich — die Punkte sind:

| Stelle                                             | Problem                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `msbClient.ts:286-292`                             | Bind-Mount-Quelle via `realpathSync` — Laufwerksbuchstaben-Pfade (`C:\…`) unter Windows ungeprüft (Spike-Punkt 3a).                                           |
| `msbClient.ts:279-282`                             | `.portBind('127.0.0.1', …)` — sollte gehen, Defender-Firewall-Prompt beim ersten Mal (Spike-Punkt 3b).                                                        |
| `msbClient.ts:229-252`                             | NetworkPolicy (deny-Egress + DNS + allowPublic + CIDR) — Verhalten unter WHP unerprobt; die Egress-Sicherheitsgrenze MUSS dort genauso greifen wie auf macOS. |
| `microsandboxProvider.ts:268-275`                  | `mode:0o700/0o600` fürs `vm-etc`-Verzeichnis mit dem **Proxy-Token** — unter Windows wirkungslos → ACL-Handling nötig (wie DB oben).                          |
| `baselineService.ts`                               | Baseline-Bau (Builder-VM, `apt-get`, Snapshot) läuft im Gast — unter WHP unerprobt (Spike-Punkt 3d).                                                          |
| `backendSelection.ts:8,44-66` + `index.ts:146-172` | Backend-Auswahl kennt `'process'                                                                                                                              | 'microsandbox'`; „echter Agent nur in MicroVM" ist hart verdrahtet. Windows ohne msb ⇒ ProcessProvider **mit deutlicher Warnung** (bzw. `MACVIBES_AGENT=fake`). |

Das `SandboxProvider`-Interface (`sandbox/provider.ts`: eine Methode
`start(context) → {previewHostPort, previewStatus(), stop()}`) ist sauber
geschnitten — ein alternatives Windows-Backend ließe sich einhängen, ohne
services/schema anzufassen. Einzige Fremdkopplung außerhalb `sandbox/`: der
Name `host.microsandbox.internal` im Agent-Transport; ein Nicht-msb-Provider
müsste ein äquivalentes Host-Gateway-Mapping stellen.

## Risiken

1. **msb-Windows ist „preview" und ~5 Wochen alt** (v0.6.0 vom 27.06.2026;
   Re-Check 2026-08-02: 0.6.8 ist aktuell, kein neueres Release). Einziger
   echter Feldtest wäre ein eigener (Stufe 0).
2. **Bun ist auf Windows die schwächste Plattform**, ausgerechnet bei
   Monorepos/Workspaces: „failed to link package with workspace" (#26543),
   kaputte `.bin`-Shims, `bun install` mit `EPERM` (#11250). Wir stehen mit
   `linker = "hoisted"` (`bunfig.toml`) zufällig auf der sicheren Seite.
   **Developer Mode** einplanen (Symlinks brauchen sonst Admin-Rechte).
   Der 1.3.14-Pin (CLAUDE.md) gilt unverändert; unter Windows via scoop/winget
   statt `brew pin` dokumentieren.
3. **Keine CI.** Kein `.github/workflows`. Die Matrix (`macos-latest` +
   `windows-latest`) wäre die erste Investition, noch vor dem Port — sonst
   erodiert der Support sofort wieder.
4. ⚠️ **Sicherheit:** Ohne msb fällt der Server auf `ProcessSandboxProvider` +
   `ClaudeAgentRunner` zurück — Claude Code mit
   `permissionMode: 'bypassPermissions'` (`agent/claudeRunner.ts:29`) direkt auf
   dem Host. Auf dem Entwickler-Mac eine bewusste Dev-Entscheidung; als
   Windows-Endzustand für fremde Nutzer inakzeptabel. `backendSelection`
   erzwingt das heute schon (`UnsafeBackendError` ohne
   `MACVIBES_ALLOW_HOST_AGENT=1`) — diese Sperre muss auf Windows genauso
   greifen.
5. **NTFS-Rechtemodell:** Alle `0o600/0o700`-Schutzmaßnahmen (DB, vm-etc-Token,
   .env-Check) sind unter Windows wirkungslos — vor einem Windows-Release
   braucht es eine bewusste Entscheidung (icacls-Äquivalent vs. dokumentierte
   Abschwächung).

## Peripherie (unkritisch)

- **Ollama:** nativ auf Windows, eigener Installer. NVIDIA voll unterstützt;
  **AMD bleibt ein Risiko** (ROCm eingeschränkt).
- **Caddy:** läuft nativ, lokale CA funktioniert, `caddy trust` einmalig
  elevated. Setup-Doku (CLAUDE.md/README) ist mac-spezifisch → ergänzen.
- **git:** portable Kommandos; Achtung auf `core.autocrlf` (`.gitattributes`
  oben) und `core.filemode=false`. Der GitHub-Mirror läuft host-seitig über das
  reguläre Credential-System (gh-Helper) — Git für Windows bringt den
  Credential Manager mit.
- **Mikro-Button** (Chrome On-Device Speech): funktioniert auf Windows-Chrome.

## Klarstellung zur Snapshot-Semantik

Ein msb-Snapshot erfasst **nur das schreibbare Dateisystem**, NICHT Memory oder
laufende Prozesse; Start daraus ist ein **Cold Boot**. Für macvibes ist das
korrekt und ausreichend (Snapshot spart das `bun install`, die VM bootet frisch
unter tini+monit). „0,8 ms CoW-Fork"-Zahlen aus Websuchen gehören zu zeroboot/
`forkd`, nicht zu microsandbox.

## Alternativen, falls msb auf Windows nicht trägt

- **WSL2 als Ganzes** (macvibes komplett in WSL2, msb mit KVM via nested
  virtualization, unter Win11 Standard): ~1–2 Tage Doku/Setup, nahezu null
  Code-Änderung. Nachteile: LAN-Erreichbarkeit braucht Port-Forwarding,
  Autostart-Handling, „fühlt sich nicht nativ an". **Der pragmatische
  Fallback.** (WSL2 als _Isolationsgrenze zwischen Nutzern_ taugt dagegen
  nicht — eine geteilte Utility-VM, ein Netzwerk-Namespace.)
- **Docker `sbx`** (Docker Desktop 4.60+, ebenfalls WHP): direktes Analogon
  mit Template-Save/Run; ebenfalls experimentell; Achtung: „execution is
  isolated, files are shared" — keine Dateisystem-Sicherheitsgrenze.
- **Windows Sandbox scheidet aus** (keine Mehrfach-Instanzen, kein eigenes
  Basis-Image, kein Port-Mapping); **`docker checkpoint`/CRIU** Linux-only;
  **Firecracker in WSL2** nur x86_64 und Eigenbau.

## Re-Check-Liste für später

- [x] ~~microsandbox-Releases~~ → 2026-08-02: 0.6.8 (29.07.) ist aktuell und
      bereits gepinnt; Windows weiterhin „preview" (npm-README). Nächster
      Check bei neuem Release: ist das Preview-Label gefallen? Gibt es
      Windows-Issues zu Bind-Mounts/Snapshots/host.microsandbox.internal?
      → https://github.com/superradcompany/microsandbox/releases
- [ ] Bun-Windows: Workspace-/Isolated-Linker-Bugs (#26543, #24543, #11250)
      geschlossen? Nutzt das Bun-Team Isolated Installs selbst auf Windows?
- [ ] Docker `sbx`: noch experimentell oder stabil?
- [ ] Erst wenn Spike (Stufe 0) grün ist, lohnen Stufe 1+2 als Paket.

## Quellen (Stand 2026-08-02)

- microsandbox: [Repo](https://github.com/superradcompany/microsandbox) ·
  [Releases](https://github.com/superradcompany/microsandbox/releases)
  (v0.6.0 Windows-Support 27.06.2026, v0.6.1 Bind-Mounts + VCRedist,
  v0.6.8 aktuell 29.07.2026) ·
  [Issue #47 geschlossen via PR #1019](https://github.com/superradcompany/microsandbox/issues/47) ·
  [npm microsandbox](https://www.npmjs.com/package/microsandbox)
  (win32-x64/arm64-msvc in optionalDependencies; „Windows support is
  currently preview")
- Docker sbx: [Why MicroVMs](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/) ·
  [CLI](https://docs.docker.com/reference/cli/sbx/)
- Bun: [#26543](https://github.com/oven-sh/bun/issues/26543) ·
  [#11250](https://github.com/oven-sh/bun/issues/11250) ·
  [Isolated Installs](https://bun.com/docs/pm/isolated-installs)
- WSL2: [microsoft/WSL#13096](https://github.com/microsoft/WSL/issues/13096) ·
  [Networking](https://learn.microsoft.com/en-us/windows/wsl/networking)
- [Ollama Windows](https://docs.ollama.com/windows) ·
  [caddy trust](https://caddyserver.com/docs/command-line#caddy-trust)
