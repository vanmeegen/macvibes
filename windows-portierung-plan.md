# Windows-Portierung: Umsetzungsplan (Stand 2026-08-05)

Detaillierter Arbeitsplan für Stufe 1 (+ Ausblick Stufe 2) auf Basis der
Analyse in [`windows-portierung.md`](windows-portierung.md). Der Stufe-0-Spike
ist bestanden (2026-08-05) — dieser Plan setzt darauf auf.

## Leitprinzip: plattformneutrale Mechanismen statt Plattform-Weichen

So wenige `process.platform`-Verzweigungen wie möglich. Konkret, in dieser
Reihenfolge der Präferenz:

1. **Von Haus aus portable APIs** nutzen (`os.devNull`, `127.0.0.1` statt
   `localhost`, `node:path`, `Bun.which`, `Bun.listen`) — null Weichen.
2. **Bun-eigene Cross-Platform-Mechanismen**: `bun exec "<kommando>"`
   interpretiert einen Shell-String mit der eingebauten Bun-Shell auf jeder
   Plattform — ersetzt `sh -c` ohne jede Weiche. Repo-Skripte werden reine
   Bun-TS-Skripte ganz ohne Shell-Syntax.
3. **Kleine Cross-Platform-Packages**, die die Weiche in der Library kapseln:
   `tree-kill` (Prozessbaum beenden; intern `taskkill /T` vs. `kill`).
   Einzige geplante neue Dependency.
4. **Feature-Detection statt Plattform-Sniffing**, wo ein Unterschied
   unvermeidlich ist: nicht „bin ich auf win32?", sondern „kann dieses
   Dateisystem POSIX-Modes durchsetzen?" / „liegt die venv-Binary in `bin/`
   oder `Scripts/`?" — geprüft durch Probieren, nicht durch Plattform-Namen.
5. **Wo gar nichts hilft**: die Weiche in EIN kleines Basisschicht-Modul
   konzentrieren (analog `os.devNull`), nie verstreut in Feature-Code.

Bewusst NICHT gewählt: `shx`/`cross-env` (lösen nur npm-Script-Probleme, die
mit Bun-TS-Skripten ganz entfallen), `execa` (schwergewichtig, Bun bringt
Spawn/Shell selbst mit).

## Mac-Schutz (oberste Randbedingung)

- **POSIX-Verhalten bleibt byte-identisch, wo immer möglich**: `os.devNull`
  ist auf POSIX exakt `'/dev/null'`; `tree-kill` sendet auf POSIX dasselbe
  SIGTERM; `127.0.0.1` ändert auf dem Mac nichts Beobachtbares.
- **CI-Matrix zuerst** (Paket P2): Jeder folgende Commit läuft auf
  `macos-latest` UND `windows-latest`. Der Mac-Leg ist von Anfang an Pflicht;
  der Windows-Leg startet als `continue-on-error` und wird am Ende von
  Stufe 1 scharf geschaltet.
- **Kleine, einzeln grüne Commits** pro Paket (`bun run ci` vor jedem Commit,
  Konvention aus CLAUDE.md); TDD: erst der fehlschlagende Test.
- **Playwright-E2E nutzt den Prozess-Provider** — genau die Pfade, die dieser
  Plan anfasst, sind damit auf dem Mac E2E-abgedeckt.
- Riskantere Umbauten (Skript-Neuschriebe P6/P7) ändern auch Mac-Verhalten →
  dort ausdrücklich Verhaltensparität als Testziel dokumentiert und auf dem
  Mac gegengetestet, bevor die alten `.sh` gelöscht werden.

## Stand der Umsetzung (2026-08-05, Abend)

**P0–P8 sind umgesetzt und committet** (P0 `windows-portierung.md`-Update,
P1 `8cd1f88`, P2 `6545f1f`, P3 `e7448fb`, P4 `609ddb9`, P5 `ea79955`,
P6 `d413bd4`, P7+P8 `dece920`). `bun run ci` ist auf dem
Windows-11-Testrechner **komplett grün** (Server 594 pass / 22 begründete
Skips / 0 fail; Web 151/151; Lint+Typecheck sauber). Offen bleiben:

1. **Mac-Gegentest** von `bun run dev`/`bun run shutdown` (neue TS-Skripte)
   und `local-router/run.ts` — danach die alten `.sh` löschen.
2. ~~Windows-CI-Leg scharf schalten~~ → 2026-08-05: Lauf zu `9e54b31` war
   auf macOS, Windows UND E2E grün; beide `continue-on-error` entfernt —
   **die volle Matrix ist jetzt Pflicht**.
3. Die **VM-Integrationstests** (`microsandboxProvider.test.ts`) sind unter
   Windows bis zum msb#1218-Fix-Release übersprungen — der Baseline-Bau in
   der Builder-VM scheitert dort an `cp` auf ro-Mounts (im echten Lauf
   verifiziert). Bei jedem msb-Release erneut prüfen.
4. Stufe 2 (unten) als eigenes Paket.

## Arbeitspakete (Reihenfolge = Ausführungsreihenfolge)

### P0 — Windows-Baseline erheben (½ h)

`bun run ci` unverändert auf dem Windows-Rechner laufen lassen und die
Fehlerliste festhalten. Beantwortet nebenbei empirisch, ob Buns eingebaute
Shell die `package.json`-Scripts (`--filter='*'`, `&&`, `VAR=x`-Präfix) schon
heute portabel ausführt — dann schrumpft P6 entsprechend.

### P1 — `.gitattributes` (½ h)

```
* text=auto eol=lf
*.png binary
*.jpg binary
*.ico binary
*.woff2 binary
```

Der Index ist heute komplett LF (`git ls-files --eol`: 271× `i/lf`, 2×
binär — verifiziert 2026-08-05), es ist also KEINE Renormalisierung nötig;
auf dem Mac ändert sich nichts. Schützt Windows-Checkouts vor
`core.autocrlf=true` (CRLF-Shebangs würden in der Linux-VM brechen).

### P2 — CI-Workflow mit Plattform-Matrix (½–1 Tag)

`.github/workflows/ci.yml` (Remote `github.com/vanmeegen/macvibes` existiert):

- Matrix `macos-latest` + `windows-latest`; Bun **exakt 1.3.14**
  (`oven-sh/setup-bun`, Pin aus CLAUDE.md), `bun install --frozen-lockfile`,
  `bun run ci`.
- Mac-Leg: Pflicht ab Tag 1. Windows-Leg: `continue-on-error: true`, bis
  Stufe 1 fertig ist (Scharfschalten = Definition of Done von Stufe 1).
- Playwright-E2E als separater Mac-Job (Prozess-Provider + Fake-Agent);
  Windows-E2E später als Ausbaustufe.

### P3 — Basisschicht `core/exec.ts`: Spawn + Kill plattformneutral (½–1 Tag)

Das Herzstück, ersetzt alle `sh -c`-Spawns und alle Signal-/Prozessgruppen-
Annahmen. Neues Modul in `core/` (Basisschicht, passt in die
Architektur-Schichtung):

- `spawnShellCommand(command, { cwd, env, logFile? }): SupervisedProcess`
  - Spawn via `Bun.spawn([process.execPath, 'exec', command])` —
    `bun exec` interpretiert den String mit der Bun-Shell, identisch auf
    Mac und Windows. Kein `sh`, kein `cmd`, keine Weiche.
  - `logFile` wird als Datei-Handle an `stdout`/`stderr` gereicht
    (`Bun.file`) — ersetzt den Shell-Redirect `>> log 2>&1`.
- `killTree(pid)` via `tree-kill`: beendet den ganzen Prozessbaum. Ersetzt
  sowohl den `exec ${cmd}`-Trick (der existierte nur, damit `proc.kill()`
  den echten Server statt der `sh` trifft) als auch `SIGTERM` auf
  Prozessgruppen.
- TDD: Test spawnt ein Kommando, das selbst ein Kind startet; `killTree`
  muss beide beenden — der Test läuft unverändert auf beiden Plattformen.

Konsumenten (je eigener kleiner Commit):

| Stelle                                 | vorher                                                     | nachher                            |
| -------------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| `sandbox/processProvider.ts:48,56`     | `Bun.spawn(['sh','-c','exec …'])` + `proc.kill('SIGTERM')` | `spawnShellCommand` + `killTree`   |
| `services/localRouterService.ts:77-82` | `sh -c` + `>> log 2>&1`                                    | `spawnShellCommand` mit `logFile`  |
| `apps/web/e2e/templates.spec.ts:52,62` | `detached:true` + `process.kill(-pid)`                     | `tree-kill` direkt (devDependency) |

Dazu gehört: `processProvider.ts:64` `localhost` → `127.0.0.1` (Windows löst
`localhost` bevorzugt `::1` auf, Dev-Server binden IPv4; auf dem Mac ohne
beobachtbaren Unterschied). Der VM-Daemon (`agent/daemon/main.ts:102`) bleibt
unangetastet — der läuft im Linux-Gast.

### P4 — `core/gitService.ts`: Härtung portabel (½ Tag) — ✅ ERLEDIGT, mit Überraschung

**Empirischer Ausgang (2026-08-05) anders als geplant:** Der Plan sah
`os.devNull` vor — aber Git lehnt Windows' `\\.\nul` als Config-Pfad ab
(„unable to access: Invalid argument"), während Git für Windows
(MSYS-basiert) die POSIX-Literale `/dev/null` und `/bin/false` selbst
korrekt übersetzt. Die Literale sind hier also die portablere Wahl und
bleiben — jetzt mit begründendem Kommentar im Code und zwei neuen
Regressionstests in `core/__tests__/gitService.test.ts`: (1) präparierter
Hook feuert nicht (F1), (2) Credential-Nachfrage gegen einen 401-Server
scheitert schnell statt zu hängen. Beide grün auf Windows; der Mac-Leg der
CI bestätigt POSIX.

### P5 — Feature-Detection für Dateirechte statt win32-Weiche (½ Tag)

Neues `core/fsCapabilities.ts`: `supportsPosixModes(dir)` legt eine
Probedatei an, setzt `0o600` und prüft per `stat`, ob die Bits wirklich
greifen (NTFS: nein → `false`). EINE Erkennung, zwei Konsumenten:

- `index.ts:114-126` (`warnIfEnvFileReadable`): auf Dateisystemen ohne
  POSIX-Modes ist `mode & 0o077` immer „lesbar" und der `chmod`-Rat sinnlos —
  stattdessen dort EINE ehrliche Warnung: „Dateirechte auf diesem Dateisystem
  nicht durchsetzbar; F25/F26 sind abgeschwächt" (die von der Analyse
  geforderte dokumentierte Abschwächung; die ACL/icacls-Entscheidung bleibt
  als bewusster Stufe-2-Punkt offen).
- `db/client.ts`: Code bleibt unverändert (`chmod` ist unter Windows ein
  stiller No-Op, `try/catch` existiert schon) — nur die Warnlogik nutzt
  dieselbe Capability, statt bei jedem Start irreführend zu warnen.

Auf dem Mac liefert die Probe `true` → Verhalten exakt wie heute.

### P6 — Repo-Skripte: `.sh` → Bun-TS ohne Shell-Syntax (1 Tag)

Das ist der größte Mac-Verhaltensberührpunkt — deshalb mit expliziter
Paritäts-Checkliste und erst löschen, wenn die TS-Fassung auf dem Mac
gegengetestet ist.

- **`scripts/preflight.sh` → `scripts/preflight.ts`**: Port-Belegt-Prüfung
  per TCP-Connect-Probe auf `127.0.0.1` (ersetzt `lsof` komplett — neutral);
  `.env`-Parsing (MACVIBES_ADMIN_USERNAME) und DB-Pfad-Kandidaten 1:1 aus
  dem Shell-Skript übernommen (inkl. des Legacy-`./data`-Kommentars).
- **`scripts/shutdown.sh` → `scripts/shutdown.ts`**: Ablauf 1:1 (erst
  dev-Elternprozess, dann Ports mit Grace-Wait, dann msb-Sweep mit den
  bewusst lauten Fehlerpfaden — die Kommentar-Historie des Skripts wandert
  mit!). Einziger nicht neutral lösbarer Teil: „welche PID lauscht auf Port
  X?" → EIN Helfer `pidsListeningOnPort()` in `scripts/lib/ports.ts` mit der
  einen gekapselten Weiche (`lsof` / `Get-NetTCPConnection`). Der msb-Sweep
  nutzt die msb-CLI, die ist cross-platform.
- **`package.json`-Scripts**: `"dev"` wird `bun scripts/dev.ts` — Preflight,
  `MACVIBES_WEB_PORT`-Default und der `bun run --filter='*' dev`-Spawn
  wandern in TS; damit verschwinden `bash`-Aufruf, `${VAR:-5173}` und alle
  Quoting-Fragen restlos (keine Shell-Syntax mehr, nichts zu escapen).
  `cd X && …`-Ketten bleiben zunächst, WENN die P0-Baseline zeigt, dass
  Bun-Shell sie portabel ausführt (erwartet: ja); sonst gleiche Behandlung.
- `.husky/`-Hooks bleiben: Git für Windows bringt `sh` mit, dort laufen sie.

### P7 — local-router: `run.sh` → `run.ts` (½ Tag)

- venv-Anlage und LiteLLM-Start in Bun-TS: Python-Suche über `Bun.which`
  (Liste `python3.11`, `python3`, `python` — Feature-Detection),
  venv-Binary über `existsSync(bin/litellm) || existsSync(Scripts/litellm.exe)`
  (Layout-Detection statt Plattform-Weiche), LiteLLM direkt als Kindprozess
  (der `exec`-Trick entfällt, `localRouterService` überwacht sowieso).
- `config.ts:142-145` (`detectLocalRouterCommand`) zeigt auf `run.ts`
  (Kommando-String korrekt gequotet — Pfade mit Leerzeichen!).
- Fallback bleibt wie gehabt: schlägt der Start fehl → `unavailable`,
  Claude-Modelle unberührt.

### P8 — E2E-Restpunkte + Windows-Leg scharf schalten (½ Tag)

- `apps/web/e2e/preview-responsive.spec.ts:5-6`: hartkodierter
  `/private/tmp/…`-Screenshot-Pfad → `testInfo.outputPath()`
  (Playwright-nativ, plattformneutral; ist unabhängig von Windows ein Bug).
- Windows-CI-Leg von `continue-on-error` auf Pflicht drehen = **Definition
  of Done für Stufe 1**.
- `windows-portierung.md` + CLAUDE.md aktualisieren (Windows-Setup-Absatz:
  Bun-Pin via winget/scoop, Defender-Allow-Regel für msb.exe, msb#1218).

## Stufe 2 (danach, separat): VM-Parität auf Windows

Durch den Spike weitgehend entrisikt; verbleibende Punkte:

1. `microsandboxProvider.ts:268-275` (vm-etc-Verzeichnis mit Proxy-Token):
   nutzt dieselbe P5-Capability; bewusste Entscheidung icacls vs.
   dokumentierte Abschwächung (Sicherheitsentscheidung, kein Code-Reflex).
2. Kompletten Server mit `MACVIBES_SANDBOX=microsandbox` auf Windows
   durchtesten (Baseline-Bau, Projekt-Lifecycle, Agent-Turn über den
   Daemon) — der Spike hat die Primitive validiert, nicht die Integration.
3. msb#1218 beobachten (ro-Bind-Mount-Reads melden Exit 1): bei jedem
   msb-Release prüfen, ob der gemergte Fix enthalten ist; bis dahin gilt der
   Vorbehalt aus der Analyse für Agent-Kommandos auf `/opt/macvibes`.
4. Boot-aus-Snapshot-Zeit im echten Baseline-Pfad messen (Spike: ~8,3 s
   vs. ~2 s auf dem Mac) und ggf. UX-Erwartung („Preview in ~2 s") anpassen.
5. Setup-Doku: Defender-Allow-Regel (`netsh advfirewall firewall add rule`)
   für die `msb.exe` unter `node_modules` — Pfad bricht bei
   Layout-Änderungen durch `bun install`, deshalb als dokumentierter
   Setup-Schritt, nicht als Automatik.

## Offene Verifikationspunkte (in P0/P3/P4 abhaken)

- [ ] `bun exec` in Bun 1.3.14 vorhanden und verhält sich auf Windows wie
      dokumentiert (sonst: Fallback ist die eine gekapselte Weiche in
      `core/exec.ts` — der Rest des Plans bleibt identisch).
- [ ] `GIT_ASKPASS=NUL` bricht unter Git für Windows sauber ab (statt zu
      hängen) — Testfall in P4.
- [ ] Führt Bun-Shell `cd apps/… && bun run …` und `--filter='*'` unter
      Windows aus? (P0-Baseline; erwartet: ja, dann bleibt `package.json`
      bis auf `dev`/`shutdown` unangetastet.)
- [ ] `tree-kill` unter Bun/Windows (nutzt `taskkill`-Spawn) — Test in P3.

## Aufwand gesamt (Stufe 1)

P0–P8 ≈ **4–5 Tage** inkl. Tests und CI-Einführung — etwas mehr als die
2–4 Tage der Analyse, weil CI-Matrix und Skript-Neuschriebe (die auch dem
Mac zugutekommen: robustere Fehlerpfade, keine `lsof`-Abhängigkeit) hier
mit drinstecken.
