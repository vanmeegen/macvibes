# macvibes unter Windows: Machbarkeitsanalyse (Stand 2026-07-24)

## Kurzfazit

**Technisch machbar — der frühere Hauptblocker ist seit Ende Juni 2026 weg.**
microsandbox hat nativen Windows-Support (WHP, **ohne WSL2**). Der reine
Code-Aufwand auf der Host-Seite ist klein (~1–2 Tage); das Risiko liegt fast
vollständig in fremder Software mit sehr jungem Reifegrad.

Zwei entlastende Befunde:

1. **microsandbox v0.6.0 (27.06.2026) unterstützt Windows nativ.** Issue #47
   („Windows Support (without WSL)", offen seit 2024) ist via PR #1019
   geschlossen. libkrun läuft dort auf der **Windows Hypervisor Platform (WHP)**
   — ausdrücklich NICHT `VirtualMachinePlatform` (das ist WSL2/Docker Desktop).
   Die hier installierte Version ist bereits **0.6.6** (07.07.2026).
   ⚠️ Die Doku nennt Windows-Support explizit **„preview"**, getestet nur auf
   Windows 11.
2. **Der gesamte Unix-Kram im Gast bleibt Linux.** `#!/bin/sh`-Skripte, `tini`,
   `monit`, `setsid`, `kill -TERM -- -PID`, der `ln -s`-Bootstrap für
   `node_modules` (ADR 0002) — alles läuft **in** der Linux-VM und muss nicht
   portiert werden. Portiert wird nur die Host-Seite.

## Aufwandsschätzung

| Stufe                                      | Aufwand    | Risiko                      |
| ------------------------------------------ | ---------- | --------------------------- |
| **1 — Host-Code entunixen** (Dev ohne VM)  | 1–2 Tage   | gering, mechanisch          |
| **2 — VM-Parität** (msb auf Windows)       | 1–3 Wochen | hoch, überwiegend Fremdcode |
| CI-Matrix macos + windows (Voraussetzung!) | 0,5–1 Tag  | gering                      |

⚠️ **Stufe 1 allein ist kein auslieferbarer Zustand** — siehe Sicherheitshinweis
unten.

## Stufe 1 — Host-Code entunixen

| Stelle                                              | Problem                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/sandbox/processProvider.ts:44`     | `Bun.spawn(['sh','-c', \`exec ${devCommand}\`])`— kein`sh` unter Windows. **Das ist der Fallback-Provider, also genau der Pfad ohne VM.**                                                                                                                             |
| `apps/server/src/sandbox/processProvider.ts:52`     | `proc.kill('SIGTERM')` — Windows kennt kein SIGTERM und keine Prozessgruppen → Kindprozesse des Dev-Servers verwaisen. Braucht `taskkill /T` oder Job Objects. Gleiches in `previewSupervisor.ts:89,192`.                                                             |
| `apps/server/src/sandbox/processProvider.ts:60`     | `httpProbe('http://localhost:<port>/')` — Windows löst `localhost` bevorzugt auf `::1` auf, der Dev-Server bindet aber IPv4 (`0.0.0.0`) → Probe schlägt fehl, Preview wird nie `ready`. Fix: `127.0.0.1`.                                                             |
| `apps/server/src/services/localRouterService.ts:78` | `sh -c` + `>> log 2>&1`-Redirect statt stdout-Datei-Handle.                                                                                                                                                                                                           |
| `apps/server/local-router/run.sh`                   | bash, `set -euo pipefail`, `"$VENV/bin/litellm"` (Windows: `Scripts\litellm.exe`). Am besten durch ein `run.ts` (Bun) ersetzen, das den venv-Pfad plattformabhängig auflöst — dann entfällt auch das `sh -c` oben. `config.ts:129-132` zeigt fest auf den `.sh`-Pfad. |
| `scripts/preflight.sh`, `scripts/shutdown.sh`       | `lsof`, `pkill`, `awk`, `xargs kill` — als plattformneutrales TS-Skript neu schreiben (wird dadurch auch auf dem Mac robuster). Blockiert sonst `bun run dev` / `bun run shutdown`.                                                                                   |
| `package.json` (mehrere Scripts)                    | `--filter='*'` — die Single Quotes überleben cmd.exe/PowerShell nicht, der Filter matcht dann nichts. Doppelquotes oder ohne Quotes.                                                                                                                                  |
| Repo-Root                                           | **Keine `.gitattributes`!** Mit Windows-Default `core.autocrlf=true` bekommen alle Dateien CRLF → Prettier/lint-staged schlagen flächendeckend fehl, und Shebangs der Gast-Skripte brechen in der Linux-VM. Fix: `* text=auto eol=lf`.                                |
| `apps/web/e2e/templates.spec.ts:49-67`              | `spawn({detached:true})` + `process.kill(-pid)` — negative PIDs gibt es unter Windows nicht.                                                                                                                                                                          |
| `apps/web/e2e/preview-responsive.spec.ts:5-6`       | Hart kodierter absoluter Screenshot-Pfad (`/private/tmp/claude-501/...`) — bricht auf jedem anderen Rechner, nicht nur Windows. Eigentlich ein Bug.                                                                                                                   |

## Stufe 2 — VM-Parität

| Stelle                                                     | Problem                                                                                                                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `microsandboxProvider.ts:163-172`, `baselineService.ts:80` | Mount-Syntax `-v <host>:<guest>` kollidiert mit Laufwerksbuchstaben — `C:\Users\...` enthält bereits einen Doppelpunkt. Muss übersetzt werden; wie msb das auf Windows erwartet, ist ungeprüft.           |
| `microsandboxProvider.ts:139-144`                          | `mkdirSync({mode:0o700})` / `writeFileSync({mode:0o600})` schützen das Proxy-Token in `daemon.env.sh`. **Windows ignoriert POSIX-Modes** → Token läge mit vererbten ACLs da. Braucht echtes ACL-Handling. |
| `apps/server/scripts/buildBaselines.ts:14-17`              | Baseline-Bau bricht ohne msb ab. Der Bau selbst läuft im Gast (`apt-get`, `install -m 600`) — sollte gehen, ist aber unter WHP unerprobt.                                                                 |
| `apps/server/src/index.ts:93-95`                           | Provider-Auswahl. Sinnvoll: Windows ohne msb ⇒ Prozess-Provider **mit deutlicher Warnung**.                                                                                                               |

Das `SandboxProvider`-Interface (`apps/server/src/sandbox/provider.ts:26-28`) ist
sauber geschnitten — ein alternatives Windows-Backend ließe sich dort einhängen,
ohne die Plattform anzufassen.

## Risiken

1. **microsandbox-Windows ist ~4 Wochen alt und „preview".** Einziger echter
   Feldtest wäre ein eigener.
2. **Bun ist auf Windows die schwächste Plattform**, ausgerechnet bei
   Monorepos/Workspaces: „failed to link package with workspace" (#26543),
   kaputte `.bin`-Shims, `bun install` mit `EPERM` (#11250). Bemerkenswert: das
   Bun-Team kann **Isolated Installs im eigenen Repo wegen eines Windows-Bugs
   nicht nutzen**, obwohl das seit 1.3.2 Default für neue Workspaces ist.
   Wir stehen mit `linker = "hoisted"` (`bunfig.toml`) zufällig auf der sicheren
   Seite. **Developer Mode** als Voraussetzung einplanen (Symlinks brauchen
   sonst Admin-Rechte).
   → Der für 1.3.14 gepinnte Stand (s. `CLAUDE.md`) gilt unverändert.
3. **Keine CI.** Kein `.github/workflows`, nichts. Eine Portierung hätte null
   Sicherheitsnetz — die Matrix (`macos-latest` + `windows-latest`) wäre die
   erste Investition, noch vor dem Port.
4. ⚠️ **Sicherheit:** Ohne msb fällt der Server auf den `ProcessSandboxProvider`
   **und** den `ClaudeAgentRunner` zurück, der Claude Code mit
   `permissionMode: 'bypassPermissions'` (`apps/server/src/agent/claudeRunner.ts:29`)
   direkt auf dem Host laufen lässt. Auf dem Entwickler-Mac ist das eine bewusste
   Dev-Entscheidung; als Windows-Endzustand für fremde Nutzer wäre es keine.

## Peripherie (unkritisch)

- **Ollama:** nativ auf Windows, eigener Installer, kein WSL/Docker. NVIDIA voll
  unterstützt (Treiber ≥531, kein CUDA-Toolkit nötig). **AMD ist ein Risiko** —
  ROCm auf Windows sehr eingeschränkt, Vulkan/DirectML nicht released.
- **Caddy:** läuft nativ, lokale CA funktioniert, `caddy trust` einmalig
  elevated. Setup-Doku im README ist mac-spezifisch und müsste ergänzt werden.
- **Mikro-Button** (Chrome On-Device Speech, PR #1): funktioniert auf
  Windows-Chrome ohne Änderung.
- **git:** `gitService.ts` nutzt nur portable Kommandos. Achtung nur auf
  `core.autocrlf` (s. `.gitattributes` oben) und `core.filemode=false`.

## Klarstellung zur Snapshot-Semantik

Die microsandbox-Startseite wirbt mit „Snapshot, fork, and restore". Die Doku
präzisiert: ein Snapshot erfasst **nur das schreibbare Dateisystem**, ausdrücklich
NICHT „Memory contents" oder „Running processes"; Start daraus ist ein
**Cold Boot**. — Für macvibes ist das **kein Problem**: wir nutzen genau diese
Semantik (Snapshot spart das `bun install` zur Laufzeit, die VM bootet frisch
unter tini+monit). Nur falls je „Fork aus warmem Zustand" angenommen wird, wäre
das schon auf macOS falsch.

Nicht verwechseln: „0,8 ms CoW-Fork"-Zahlen aus Websuchen gehören zu **zeroboot**
bzw. `forkd`, nicht zu microsandbox.

## Nächster Schritt (billigster Erkenntnisgewinn)

Kein Code, sondern ein Experiment auf einem **Windows-11**-Rechner:

1. WHP-Feature aktivieren (`HypervisorPlatform`, nicht `VirtualMachinePlatform`)
   - Virtualisierung im UEFI; `msb doctor --fix` hilft (öffnet elevated
     PowerShell).
2. `irm https://install.microsandbox.dev/windows | iex`
3. Einen einzigen Container starten **mit Volume-Mount und Port-Publishing** —
   genau die zwei Dinge, an denen es scheitern wird
   (Laufwerksbuchstaben-Doppelpunkt, Defender-Firewall-Abfrage beim ersten
   Publish).
4. Trägt das, ist der Rest Fleißarbeit. Trägt es nicht, sind zwei Wochen gespart.

## Alternativen, falls msb auf Windows nicht trägt

- **Docker `sbx`** (seit März 2026, Docker Desktop 4.60+) ist das direkte
  Analogon: eigener VMM von Docker, auf Windows ebenfalls **WHP**;
  `sbx template save` + `sbx run -t` = vorbereiteten Zustand einfrieren und
  daraus starten; Port-Publishing via `sbx ports`. Ebenfalls **experimentell**
  („things will break, the API will change"), aber größerer Hersteller.
  Wichtig: Workspace-Dateien sind Passthrough — „execution is isolated, files
  are shared", also **keine** Dateisystem-Sicherheitsgrenze.
- **WSL2 allein taugt nicht als Isolationsgrenze**: alle Distros teilen sich
  eine Utility-VM, einen Kernel und einen Netzwerk-Namespace → Ports kollidieren
  zwischen Instanzen (microsoft/WSL#13096, seit 12.06.2025 unbeantwortet).
- **Windows Sandbox scheidet aus**: laut Microsoft keine mehreren Instanzen
  gleichzeitig, kein eigenes Basis-Image, kein Port-Mapping.
- **`docker checkpoint` (CRIU) gibt es auf Windows nicht** (Linux-only).
- **Firecracker in WSL2** ginge auf Windows 11 / x86_64 (nested virtualization
  ist dort Default), aber **nicht auf ARM64** und seit 06.01.2026 nicht mehr auf
  Windows 10. Port-Forwarding zweistufig und Eigenbau.

## Re-Check-Liste für später

- [ ] microsandbox-Releases: ist Windows noch „preview"? Gibt es Windows-Issues
      zu Volume-Mounts/Snapshots? → https://github.com/microsandbox/microsandbox/releases
- [ ] Bun-Windows: sind die Workspace-/Isolated-Linker-Bugs geschlossen
      (#26543, #24543, #11250)? Nutzt das Bun-Team Isolated Installs inzwischen
      selbst auf Windows?
- [ ] Docker `sbx`: noch experimentell oder stabil?
- [ ] Erst wenn 1 + 2 grün sind, lohnt Stufe 2.

## Quellen (Stand 2026-07-24)

- microsandbox: [Repo](https://github.com/microsandbox/microsandbox) ·
  [Releases](https://github.com/microsandbox/microsandbox/releases) ·
  [Issue #47](https://github.com/superradcompany/microsandbox/issues/47) ·
  [Windows-Troubleshooting](https://docs.microsandbox.dev/troubleshooting/windows.md) ·
  [Snapshots](https://docs.microsandbox.dev/sandboxes/snapshots.md)
- Docker sbx: [Why MicroVMs (16.04.2026)](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/) ·
  [CLI](https://docs.docker.com/reference/cli/sbx/)
- Bun: [#26543](https://github.com/oven-sh/bun/issues/26543) ·
  [#11250](https://github.com/oven-sh/bun/issues/11250) ·
  [Isolated Installs](https://bun.com/docs/pm/isolated-installs)
- WSL2: [microsoft/WSL#13096](https://github.com/microsoft/WSL/issues/13096) ·
  [Networking](https://learn.microsoft.com/en-us/windows/wsl/networking)
- [Ollama Windows](https://docs.ollama.com/windows) ·
  [caddy trust](https://caddyserver.com/docs/command-line#caddy-trust)
