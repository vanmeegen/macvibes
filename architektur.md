# architektur.md — Entscheidungsdokument für die Architektur-Session

> Schwester-Datei zu `chatproblems.md`. Während `chatproblems.md` die
> **Fehler-Chronik** ist ("was ging schief, was war Pflaster"), ist **diese**
> Datei das **Zukunfts- und Entscheidungsdokument**: welche Architektur-Fragen
> müssen wir bewusst entscheiden, bevor wir weiter Pflaster stapeln.
>
> Status: **Entschieden am 2026-07-06 (Session mit Marco), Spike implementiert**
> — siehe „Entscheidungen + Spike-Stand" direkt hier drunter. Der Rest der
> Datei ist die ursprüngliche Diskussionsgrundlage.

---

## Entscheidungen + Spike-Stand (2026-07-06)

**Entschieden:**

1. **A+C kombiniert**: persistenter **Agent-Daemon in der VM** (Bun), der das
   **Agent SDK im Streaming-Input-Modus** nutzt — EINE langlebige `query()`
   über alle Turns, `interrupt()` statt Kill (behebt #13 ursächlich), kein
   `--resume` pro Turn. Transport: der Daemon wählt sich **ausgehend** per
   WebSocket beim Host-Gateway ein (`/agent`, gleicher Weg wie der
   Credential-Proxy). msb nur noch für VM-Lifecycle.
   Verifizierte SDK-Fakten dazu: das SDK spawnt die CLI als Subprozess (Tools
   laufen, wo das SDK läuft → „C pur" auf dem Host würde die Isolation
   brechen); `interrupt()`/`setModel()` nur im Streaming-Modus; Sessions
   weiter auf Platte (`CLAUDE_CONFIG_DIR` bleibt), `resume`/`forkSession`
   als Recovery-Hebel.
2. **Vorgehen: Spike hinter Flag, dann Rückbau.** Der Härtetest (Browser,
   mehrere Projekte, Interrupts) ist grün → der Daemon ist seit 2026-07-07 der
   **einzige** VM-Transport; das Flag `MACVIBES_AGENT_TRANSPORT` und der
   exec-Pfad (vmRunner/msbExecSpawner) sind **entfernt** (Phase 2, s. u.).
3. **Supervision: Fertiges statt Eigenbau** (Marcos Leitplanke): PID 1 der VM
   ist ein echter Supervisor statt `sleep infinity`; der host-seitige
   PreviewSupervisor-Watchdog entfällt in diesem Pfad (Host LIEST nur noch
   Status). Kein Python im Image → **entschieden für tini + monit**
   (2026-07-07): monit hat den echten msb-Härtetest bestanden (Restart,
   Crash-Loop→Endzustand, Status-HTTP-API) und kommt als Debian-Paket;
   der Duell-Kandidat horust wurde verworfen — sein aarch64-Release-Asset
   (`-gnu` statt `-musl`) wurde vom Baseline-Install nie getroffen, d. h. er
   lief bei uns nachweislich nie, ist prä-1.0/Nische und hat keine
   Status-API (previewStatus verlöre den failed-Zustand). Der horust-Pfad
   ist vollständig entfernt.

**Implementiert (Branch `architektur`):**

- `apps/server/src/agent/daemon/` — Protokoll, `DaemonSession` (SDK-Streaming,
  Interrupt-Semantik, Modellwechsel-Guard), `main.ts` (WS-Client, Reconnect)
- `apps/server/src/agent/agentGateway.ts` + `daemonRunner.ts` — Host-Seite;
  `chatService` unverändert (der `AgentRunner`-Seam trägt)
- `apps/server/src/sandbox/vmServices.ts` — monit-Konfiguration (monitrc +
  Run-Wrapper); `monitStatus.ts` + `previewStatusPoller.ts` für
  `previewStatus` (nur lesen); `microsandboxProvider.start` bootet die VM unter
  tini+monit
- Baseline backt Agent SDK (`/opt/macvibes`) + tini/monit ein —
  `bun run baselines` nach dem Umstellen nötig
- Integrationstest gegen echtes msb (gated):
  `MACVIBES_TEST_MSB=1 bun test daemonTransport.msb` — Daemon-Connect,
  monit-Restart-Heilung, mit Credentials auch Turn/Interrupt/Kontext

**Spike-Befunde aus dem echten msb-Lauf (2026-07-06, alle behoben — der
Integrationstest ist grün inkl. Turn/Interrupt/Kontext):**

- **msb-NAT lässt Verbindungen halbtot zurück**: FIN/RST der VM-Seite kommen
  nicht immer am Host an — der Gateway-Socket bleibt scheinbar offen, Sends
  verschwinden spurlos. Gegenmittel: `turn-started`-**Quittung** pro Turn
  (bleibt sie 5s aus → Abbruch + Verbindung verwerfen; der chatService-Retry
  trifft die frische Verbindung) plus **Heartbeat** (ping/pong alle 15s hält
  den NAT-Flow in beide Richtungen warm).
- **tini braucht `-s` (Subreaper)**: In der msb-VM ist unser PID-1-Kommando
  nicht das echte Init — ohne `-s` bleiben tote Services **Zombies** und monit
  startet nie neu („process is a zombie" im 2s-Takt).
- **msb-exec-Sessions haben eigene PID-Namespaces**: Sie können den PID-1-Baum
  nicht killen (Pidfile-PIDs laufen ins Leere). Daher `shutdown`-Kommando im
  Protokoll — nur der Daemon selbst kann sich zuverlässig beenden.
- **monit färbt seine Status-API mit ANSI-Codes** — der Parser strippt sie.
- **Baseline-Builder brauchte `waitForExecReady`** + kurze exec-Schritte statt
  eines Mega-Befehls (sonst „exec session ended without exit event").

**Härtetest-Befunde (2026-07-07, im Browser über mehrere Projekte, behoben):**

- **Projekt-Trennung im Frontend war undicht**: `ChatStore.connect()` awaitete
  die Historie, bevor die SSE-Subscription entstand — die verspätete Antwort
  eines alten Projekts überschrieb das neue, und pro Projektwechsel/StrictMode-
  Doppelmount leakte eine EventSource. Ab ~6 offenen SSE-Streams blockiert der
  Browser alle weiteren Requests an den Origin (Chat leer, Status-Polling tot).
  Gegenmittel: `connectEpoch` entwertet veraltete connects, `applyEvent`
  verwirft Fremd-`projectId`s, `disconnect()` bricht laufende connects ab.
- **Preview meldete zu früh `ready`**: monit sieht nur den Prozess, Vite/bun
  antworten HTTP erst Sekunden später → das iframe lud ins Leere. Gate:
  `ready` erst mit echter HTTP-Probe auf den Preview-Port (`gateReadyWithProbe`).

**Phase 2 — erledigt (2026-07-07, Daemon ist der einzige VM-Pfad):**

- Entfernt: `vmRunner.ts`, `msbExecSpawner.ts` (+`KILL_ORPHANS`), der 1,5s-
  Stagger, das Flag `MACVIBES_AGENT_TRANSPORT`, `msbExec`, der CLI-Zeilenparser
  (`parseStreamJsonLine`), der globale claude-CLI-Install im Baseline.
- `microsandboxProvider` vereinheitlicht: PID 1 = tini+monit, Preview-Status
  wird nur gelesen; Baseline (SDK + tini/monit + node_modules) ist Pflicht.
- `chatService`-Timeouts + Auto-Retry **bewusst behalten**: ACK-Watchdog und
  der Turn-1-Retry haben sich im Härtetest gegen die msb-NAT-Halbtot-
  Verbindung bewährt (nicht entschärfen).

**Offen (optional, später):**

- Host-seitig `launchd`-Plist für den Produktionsbetrieb (`bun run start`).
- monit-Basic-Auth, falls die Status-API je über `127.0.0.1` hinaus exponiert
  wird (aktuell nur host-lokal gemappt).

**msb-Secrets statt Credential-/Egress-Proxy — GEPARKT (Branch
`msb-secrets-spike`, 2026-07-09):**

msb bietet Secret-Injection (`--secret NAME@host`: VM sieht nur den
Platzhalter `$MSB_<NAME>`, Substitution host-seitig am Egress) und
Domain-Netzregeln — das könnte anthropicProxy + egressProxy (~700 Zeilen)
ersetzen. Der Umbau ist implementiert und **funktioniert isoliert** (echter
SDK-Turn mit Platzhalter: verifiziert), scheitert aber an einem
**Regel-Engine-Bug in msb 0.6.2–0.6.6**: von den vier nötigen Pfaden
(Host-Gateway 172.16/12 fürs Agent-WS · Public-Egress npm · Secret-Host
api.anthropic.com · LAN-Block) liefert JEDE Regelkombination nur drei —

| Regeln                                            | Gateway | Public | Secret-Host | LAN-Block |
| ------------------------------------------------- | ------- | ------ | ----------- | --------- |
| Gruppen (`allow@public,allow@172.16/12`) + Secret | ✓       | ✗      | ✗           | ✓         |
| Domain- + Gruppenregeln                           | ✗       | ✗      | ✓           | ✓         |
| `--net-default-egress allow` + CIDR-Denies        | ✗       | ✓      | ✓           | ✓         |
| keine Regeln                                      | ✗       | ✓      | ✓           | ✓         |

Kernbugs: (a) jede Domain-Regel deaktiviert Gruppen-/CIDR-Regeln, (b) der
Gateway-Pfad stirbt unter `--net-default-egress allow`, (c)
`host.microsandbox.internal` ist als Domain-Regel nicht matchbar. Erledigt,
wenn upstream gefixt (Issue melden!). Wichtige Erkenntnisse für den Wieder-
einstieg: monit vererbt die Platzhalter-Env NICHT (explizit in daemon.env.sh
schreiben, Platzhalter ist deterministisch `$MSB_<NAME>`); ab msb 0.6.6 nur
noch `NAME@HOST`-Form (Wert aus der Host-Env des msb-Aufrufs, nie inline).
Weiterer Befund: Public-Egress ist mit Gruppen-Regeln auch OHNE Secret tot
(0.6.2 wie 0.6.6) — der egressProxy bleibt also so oder so nötig.

---

## Die eine Kernthese

**Wir kontrollieren den Zustand des Agenten nicht — wir kontrollieren nur einen
Prozess, den wir extern starten und killen.** Fast alle Schmerzen dieser Woche
(siehe `chatproblems.md`) sind Symptome davon:

- Wir starten `claude` als **CLI-Prozess** in der VM per `msb exec`.
- Sein Gesprächs-/Sitzungszustand lebt **in der VM** (eine `.jsonl`-Datei), von
  claude selbst geschrieben, für uns eine Black Box.
- Wir sprechen mit ihm nur über zwei schmale Kanäle: **stdin/args rein**
  (Prompt + `--resume <id>`), **stdout raus** (stream-json).
- Wenn etwas schiefgeht, ist unser einziges Werkzeug **Prozess killen** — was
  den internen Zustand beschädigen kann (siehe Session-Korruption unten).

Die Frage der Session ist also nicht "wie fixen wir Bug X", sondern: **wollen
wir den Agent-Zustand selbst besitzen, statt ihn einer CLI-Black-Box in der VM
zu überlassen?**

---

## Fallstudie: Session-/Kontext-Handling (der aktuelle Anlass)

### Was "Kontext" eigentlich ist (zwei getrennte Ebenen)

1. **Chat-Historie** — liegt in **unserer** DB (`chat_messages`). Vollständig,
   überlebt alles, wird im UI angezeigt. **Besitzen wir.**
2. **Datei-/Workspace-Zustand** — das, was der Agent gebaut hat, liegt im
   gemounteten Volume. Überlebt VM-Neustarts. **Besitzen wir.**
3. **claudes internes Sitzungsgedächtnis** — die `.jsonl` in `/agent-config`:
   exakte Nachrichtenfolge inkl. Tool-Calls, Tool-Ergebnisse, Thinking-Blöcke,
   Prompt-Cache-Anker. **Besitzen wir NICHT** — claude schreibt und liest sie
   selbst; wir referenzieren sie nur per `--resume <id>`.

Entscheidend: **Pro Turn geben wir claude nur den neuen Prompt + `--resume`.**
Die gesamte Konversation trägt allein `--resume`. Ohne `--resume` sieht claude
buchstäblich nur den neuen Prompt (z. B. nur "weiter") — gedächtnislos.

### Das Problem, das das offenlegt

- **Interrupt korrumpiert die Session** (chatproblems.md #13): Turn per neuem
  Prompt unterbrechen → Kill trifft claude mitten im `.jsonl`-Schreiben →
  Session inkonsistent → jeder Folge-`--resume` hängt.
- **Unser aktueller Fix** (a5e5597): Retry startet ohne `--resume` → heilt, aber
  **verwirft Ebene 3** (claudes Gedächtnis). Der Agent startet leer und muss
  sich den Stand aus den Dateien neu erlesen.

### Die Recovery-Idee (Marcos Frage) und warum sie nicht trivial ist

Intuition, völlig richtig: "Wir haben die Historie doch in der DB — dann
rekonstruiere den Kontext daraus, statt ihn zu verwerfen."

Technisch stehen wir aber vor der schmalen CLI-Schnittstelle. Optionen:

- **(R1) Historie in den Prompt-Text packen:** `prompt = "Bisheriger Verlauf:\n
…\n\nAktuelle Aufgabe:\n…"`. Funktioniert ohne CLI-Tricks, aber: bläht jeden
  Prompt auf, kein echter Prompt-Cache, Tool-Call-Details gehen als reiner Text
  rein (nicht als strukturierte Tool-Ergebnisse). Pragmatisch, aber ein Hack.
- **(R2) claudes `.jsonl`-Session aus der DB rekonstruieren** und `--resume`
  darauf. Gibt echtes Resume inkl. Struktur — aber **fragil**: wir müssten
  claude-codes internes Session-Format nachbauen und pflegen (bricht bei jedem
  claude-Update potenziell).
- **(R3) Session gar nicht erst korrumpieren lassen:** Interrupt/Kill sauberer
  gestalten (claude Zeit zum Flushen geben, SIGINT statt SIGKILL, o. ä.). Behebt
  die Ursache statt der Recovery — aber wir haben nur `proc.kill()` über
  `msb exec`, dessen Kill-Semantik wir nicht fein steuern.

**Keine dieser Optionen ist sauber, solange claude eine CLI-Black-Box hinter
`msb exec` ist.** Genau deshalb gehört Recovery in die Architektur-Entscheidung,
nicht in einen Quick-Fix.

---

## Die große Weggabelung: Agent-Transport

Aus `chatproblems.md` übernommen und vertieft. **Das ist die eigentliche
Entscheidung.**

### Option A — Persistenter Agent-Daemon in der VM (HTTP/WS statt exec-Pipe)

Statt pro Turn `msb exec claude …` zu starten, läuft **ein langlebiger
Agent-Prozess** in der VM, der über HTTP/WebSocket mit dem Host spricht.

- **Löst auf einen Schlag:** stdout-Pufferung (`--stream` unnötig),
  Session-Vermischung, Orphan-Kill, PID-Namespace-Probleme, Kill-Semantik.
- **Session-Kontrolle:** der Daemon kann seinen Zustand explizit exponieren
  (pausieren, sauber abbrechen, Kontext dumpen) — Interrupt korrumpiert nichts
  mehr, Recovery wird trivial.
- **msb** wird auf das reduziert, wofür es gut ist: Netz-/FS-Sandboxing. Nicht
  mehr Prozess-Transport.
- **Kosten:** wir müssen den Daemon bauen/betreiben; er muss die claude-Logik
  kapseln (CLI im Daemon, oder gleich SDK — siehe C).

### Option B — microsandbox grundsätzlich in Frage stellen

Ist die VM-Isolation den Preis wert? `msb` hat uns ~9 eigenständige
Fragilitäten beschert.

- **Alternativen:** andere MicroVM-/Container-Runtime mit besserem exec-
  Streaming und sauberer Kill-Semantik; oder (weniger Isolation) Prozess-Sandbox
  direkt auf dem Host.
- **Kosten:** Isolation ist ein Kern-Sicherheitsversprechen von macvibes
  (fremder/agenten-generierter Code läuft isoliert). Aufgeben ist heikel.

### Option C — Claude Agent SDK statt CLI-über-Pipe

Der Host-Server spricht die Claude-API **selbst** (Agent SDK), Tool-Ausführung
läuft in der Sandbox.

- **Kein stdout-Stream-Parser mehr**, kein `--resume`-Wette: Streaming und
  Konversationszustand sind **SDK-Features, die wir besitzen** — die Historie
  liegt in unserer DB und wird pro Request mitgegeben (Recovery = geschenkt).
- Session-Korruption durch Kill existiert nicht mehr, weil es keine
  claude-eigene Session-Datei mehr gibt.
- **Kosten:** Tool-Ausführung (bash/edit/…) müssen wir selbst in die Sandbox
  routen; das ist genau die Arbeit, die die CLI uns heute abnimmt. Verschiebt
  die Komplexität vom Transport zur Tool-Bridge.

### Erste Einordnung (nicht entschieden)

- **A und C schließen sich nicht aus** — ein Agent-Daemon (A), der intern das
  SDK (C) nutzt, kombiniert die Vorteile: Isolation bleibt (msb), Zustand
  besitzen wir, Transport ist sauber.
- **B** ist die radikalste Frage und sollte bewusst gestellt, aber wahrscheinlich
  zugunsten von "msb behalten, aber nur fürs Sandboxing" beantwortet werden.

---

## Konkrete offene Entscheidungen (für die Session)

1. **Besitzen wir den Agent-Zustand selbst (A/C) oder bleiben wir bei
   CLI-über-`msb exec` und pflegen die Pflaster-Sammlung weiter?**
2. Falls A/C: **CLI im Daemon** oder **SDK**? (Tool-Bridge-Aufwand vs.
   Parser-Wegfall gegeneinander abwägen.)
3. Falls wir bei der CLI bleiben (kurzfristig): **welche Recovery-Variante**
   (R1 pragmatisch / R2 fragil / R3 Ursache)? R1 ist der wahrscheinlichste
   Zwischenschritt.
4. **Wie testen wir das kritische Stück?** Heute läuft CI mit dem Fake-Provider
   — der eigentliche Schmerz (echtes msb, echtes claude) ist ungetestet. Ohne
   einen Integrationstest gegen echtes msb bleibt die CI blind (chatproblems.md
   §"getestet ≠ funktioniert").

---

## Was NICHT vergessen werden darf (Kontext aus dieser Woche)

- Der **Egress-Bug** (msb blockt Public bei net-rules) ist real und bleibt, egal
  welchen Transport wir wählen — der Host-Egress-Proxy ist unabhängig sinnvoll.
- **Port-Allocator** und **Config-Warmup** sind saubere, transport-unabhängige
  Bausteine — die bleiben in jeder Variante.
- Die **msb-Rest-Flakiness** (exec hängt intermittierend) ist nie ganz geklärt.
  Falls sie an der exec-Session-Etablierung liegt, würde Option A sie mit
  beseitigen — ein weiteres Argument für A.
