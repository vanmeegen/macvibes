# architektur.md — Entscheidungsdokument für die Architektur-Session

> Schwester-Datei zu `chatproblems.md`. Während `chatproblems.md` die
> **Fehler-Chronik** ist ("was ging schief, was war Pflaster"), ist **diese**
> Datei das **Zukunfts- und Entscheidungsdokument**: welche Architektur-Fragen
> müssen wir bewusst entscheiden, bevor wir weiter Pflaster stapeln.
>
> Status: Diskussionsgrundlage, noch **keine** Entscheidungen getroffen.

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
