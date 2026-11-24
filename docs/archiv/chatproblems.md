# chatproblems.md — ehrliche Analyse: warum der Chat immer noch nicht zuverlässig läuft

> Zusammengetragen am Ende einer sehr langen Debugging-Session. Zweck: nüchtern
> festhalten, **was** wir gefixt haben, **welches Muster** dahintersteckt, und die
> offene Frage beantworten: **Rumgemurkse, Architektur-Mist, oder beides?**
> Diese Datei ist bewusst selbstkritisch. Sie soll Grundlage für eine
> Architektur-Entscheidung sein, nicht die bisherige Arbeit rechtfertigen.

---

## TL;DR (ehrlich)

- Das **Kernsymptom** ("ewig _Agent arbeitet_, kein Denken, dann nichts") hatte
  über die Session hinweg **mindestens 6 verschiedene, voneinander unabhängige
  Ursachen**. Wir haben sie einzeln gefunden und gefixt. Aber weil es _mehrere_
  waren und alle im selben Symptom mündeten, sah es für dich jedes Mal so aus,
  als wäre "nichts besser".
- Fast **jede** Ursache lag an **einer einzigen Komponente: `microsandbox`
  (`msb exec`)** als Transport für den Agenten. Das ist das eigentliche Signal.
- Meine "alles getestet / alle Bedingungen erfüllt"-Aussagen waren **unter
  Laborbedingungen** wahr (frischer Server, EINE VM, keine Konkurrenz, oft von
  mir per GraphQL statt echtem Browser). Deine reale Nutzung trifft andere
  Bedingungen (mehrere VMs, Kaltstart, Parallelität, Zeit) — dort bricht es.
  **Das ist mein Fehler in der Verifikation, kein Detail.**
- Meine Einschätzung: **~40% Rumgemurkse (Symptom-Pflaster gestapelt), ~60%
  fragile Architektur.** Die Grundentscheidung "Agent als CLI-Prozess über eine
  `msb exec`-stdout-Pipe streamen" hat rund **ein Dutzend** eigenständige
  Fragilitäten produziert. Das ist kein Zufall, das ist die Grundlage.

---

## Das Kernsymptom

"Chat startet, oben steht _Agent arbeitet …_, es passiert 10–180 s lang nichts,
kein Denk-Stream, oft endet es mit Fehler oder Timeout." — mehrfach, über Tage.

Wichtig: Dieses **eine Symptom** kann aus jeder der unten gelisteten Ursachen
entstehen. Deshalb war jeder einzelne Fix "richtig" und trotzdem war das
Erlebnis danach oft unverändert — weil noch eine andere Ursache aktiv war.

---

## Chronologie: gefundene Ursachen und Fixes (mit ehrlicher Bewertung)

Bewertung je Punkt: **[Root-Cause]** = echte Wurzel behoben · **[Workaround]** =
Symptom abgefedert, Ursache liegt tiefer (meist in msb).

1. **Denk-Stream war leer/verschlüsselt** — Proxy erzwingt `thinking.display:
"summarized"`; Fix, dass auch `adaptive` (nicht nur `enabled`) getroffen wird.
   _(Commits dc99a75, 25f2142)_ — **[Root-Cause]** für "kein Denken sichtbar",
   ABER nur die halbe Wahrheit: der Denk-Text kam trotzdem nicht live an (siehe
   Punkt 11).

2. **Modell auf Sonnet 5 umgestellt** für gehaltvolleren Denk-Stream
   _(0153e1e)_ — **[Designentscheidung]**, an sich ok.

3. **Turn hing nach Modellwechsel** — bestehende Opus-Session wurde mit
   `--resume … --model sonnet` fortgesetzt → Claude Code hängt. Session-Resume
   jetzt modellgebunden _(91848cd)_ — **[Root-Cause]**, aber selbst verursacht
   (durch Punkt 2). Ein Fix für ein Problem, das wir gerade erst geschaffen
   hatten.

4. **Watchdog**: stiller Hänger → sichtbarer Fehler + Turn-Ende statt ewig
   "Agent arbeitet" _(fc16cc4)_ — **[Workaround]**. Behandelt das _Symptom_
   (Hänger), nicht die Ursache (warum hängt msb exec?).

5. **Fehler-Surfacing** (aufklappbare "Interner Fehler"-Zeilen) _(fc16cc4)_ —
   **[Workaround/richtig]**: gut fürs Debugging, ändert aber nichts an der
   Zuverlässigkeit.

6. **Auto-Retry** bei stummem Start _(3c64d0e)_ — **[Workaround]**. Wir
   _wiederholen_ einen Turn, weil msb exec manchmal nichts liefert. Ein Retry ist
   ein Eingeständnis, dass die darunterliegende Schicht unzuverlässig ist.

7. **Orphan-Kill**: verwaiste `claude`-Prozesse in der VM machten neue Turns
   "stumm" (msb vermischt Streams gleichzeitiger exec-Sessions) _(8867c39)_ —
   **[Workaround für msb-Bug]**. `proc.kill()` beendet nur die Host-Seite von
   `msb exec`; der Gast-Prozess lief weiter. Das ist eine msb-Eigenheit, die wir
   umschiffen mussten.

8. **Boot-Feedback** ("MicroVM startet …") _(8d2f636)_ — **[UX-Pflaster]**.
   Macht das Warten _erklärbar_, nicht _kürzer_.

9. **microsandbox blockt JEDEN Public-Egress, sobald `--net-rule` gesetzt ist**
   → claudes Startup-Calls liefen ~180 s in Connect-Timeouts. Host-Egress-Proxy
   gebaut _(aa021ea)_ — **[Root-Cause]**, und ein _echter_ msb-Bug (auch
   `allow@0.0.0.0/0` blockt Public). Das war die beste Detektivarbeit der
   Session — aber es ist wieder ein Workaround um eine msb-Macke.

10. **Port-Kollision** bei parallelen Sandboxen (zwei pwa-Projekte wollen beide 5173) — `PortAllocator` _(186b603)_ — **[Root-Cause]**, sauberer Fix. Einer
    der wenigen Punkte, der _nichts_ mit msb-Fragilität zu tun hat, sondern ein
    echter eigener Logikfehler war.

11. **Kein Live-Streaming**: `msb exec` **puffert stdout komplett** und flusht
    erst bei Prozessende → der ganze Turn (Denken + alle Tools) kam gebündelt am
    Ende. Fix: `msb exec --stream` _(dba010b)_ — **[Root-Cause]**, und der
    wichtigste. **Das bedeutet: Punkt 1 (Denk-Stream aktivieren) war die ganze
    Zeit für die Katz, solange der stdout gepuffert war.** Wir haben tagelang an
    "warum kein Denken" gearbeitet, und die eigentliche Ursache (msb puffert)
    kam erst ganz am Ende.

12. **30-s-Kaltstart**: Dev-Server-Boot (Vite/bun) frisst beide VM-CPUs, der
    erste Agent-Turn verhungert. Fix: 4 CPUs + `nice` für den Dev-Server, plus
    Kaltstart-Timeout _(2235154, 5c1d972, 1a1e433)_ — **[Workaround]**. Wir
    geben mehr Ressourcen und drosseln, statt die zwei Lasten sauber zu trennen.

13. **Interrupt korrumpiert die claude-Session → Endlos-Deadlock** _(live
    reproduziert am 2026-07-06)_: Wird ein laufender Turn per neuem Prompt
    unterbrochen, killt der Abort claude **mitten im Session-Schreiben**. Die
    `.jsonl`-Session bleibt inkonsistent zurück. Danach hängt **jeder** Folge-
    Prompt, weil `--resume` auf die kaputte Session kein Event liefert; auch der
    Auto-Retry resumte bisher DIESELBE kaputte Session → wieder Hänger. Raus/rein
    half nicht (die `claude_session_id` ist persistiert). Fix: der Retry startet
    jetzt **ohne** Resume (frische Session) → heilt sich _(a5e5597)_ —
    **[Workaround für msb/claude-CLI-Fragilität]**. Wieder ein Symptom davon, dass
    wir einen langlebigen CLI-Prozess extern killen und seinen internen Zustand
    (Session-Datei) nicht kontrollieren. Kostenpunkt: nach einem Interrupt ist der
    erste Folge-Prompt einmalig langsam (hängender Resume-Versuch + Retry), und
    der claude-interne Gesprächskontext geht in dem Fall verloren.

---

## Das übergreifende Muster (das eigentliche Problem)

Von 12 Punkten betreffen **8–9 direkt `microsandbox`/`msb exec`**:

- msb exec **puffert stdout** (→ kein Live-Streaming ohne `--stream`)
- msb exec **serialisiert/vermischt** gleichzeitige exec-Sessions
- msb exec **PID-Namespaces** pro Session (PID-Files nutzlos, Detach unmöglich)
- msb `proc.kill()` **beendet den Gast-Prozess nicht** (Orphans)
- msb **blockt Public-Egress**, sobald eine net-rule gesetzt ist
- msb exec **hängt intermittierend** (die nie ganz geklärte Rest-Flakiness)
- msb `run -d` **kehrt zurück, bevor exec bereit ist** (waitForExecReady, früher)
- VM-Boot-/Kaltstart-Kosten, CPU-Konkurrenz in der VM

Das ist **kein** normales "jede Software hat Bugs". Das ist eine Häufung von
Fragilitäten in **genau der Schnittstelle**, über die der Agent lebt: den
langlebigen Prozess `claude` per `msb exec` starten und seinen stdout live zum
Host streamen. Diese Schnittstelle war offenbar **nicht dafür ausgelegt**, einen
minutenlangen, streamenden Prozess zuverlässig zu tragen.

---

## Warum "getestet, alles grün" ≠ "funktioniert bei dir" (mein Fehler)

Ehrlich benannt, damit wir es nicht wiederholen:

1. **Laborbedingungen statt Realität.** Ich habe fast alles verifiziert mit:
   frisch gestartetem Server, EINER frischen VM, keiner parallelen Last, und oft
   **per GraphQL/DB statt echtem Browser-Klick**. Deine Realität: mehrere
   Projekte/VMs, warme _und_ kalte Starts, echte SSE-Subscription, Zeitdruck.
2. **Ich habe meine eigenen Messungen verfälscht.** Mehrfach liefen meine
   parallelen `msb exec`-Diagnosebefehle _gleichzeitig_ mit dem Agenten — und
   weil msb exec serialisiert, sah ich künstliche Hänger (oder umgekehrt: nach
   Aufräumen künstlich gute Zahlen). Ich habe daraus teils falsche Schlüsse
   gezogen ("es ist nur ein Mess-Artefakt").
3. **"Grüne CI" sagt fast nichts über dieses Problem.** Die Unit-/Integrations-
   Tests laufen mit dem **Fake-Provider**, nicht gegen echtes msb. Das Kern-
   problem lebt genau dort, wo die Tests _nicht_ hinschauen.
4. **Symptom-Fixes stapeln erzeugt Scheinfortschritt.** Watchdog + Retry +
   Timeouts + Boot-Feedback fühlen sich nach Fortschritt an, verbergen aber, dass
   die Grundschicht unzuverlässig bleibt. Sie machen Ausfälle _sichtbarer und
   überlebbar_, nicht _seltener_.
5. **Ich habe nie den echten Härtetest gefahren**, den du meinst: Browser
   öffnen, 5–10 Turns hintereinander über mehrere Projekte, kalt und warm, ohne
   dass ich parallel in der VM herumstochere — und _dabei_ zuschauen. Genau der
   fehlt bis heute.

---

## Die Architektur-Frage (die eigentliche Entscheidung)

**Ist die Grundarchitektur tragfähig?** Aktuell:

```
Host (Bun-Server)
 ├─ Credential-Proxy (4000)   ── API-Calls der VM
 ├─ Egress-Proxy (4010)       ── restlicher VM-Traffic (weil msb Public blockt)
 └─ pro Projekt: msb exec ──▶ claude-CLI in MicroVM
                               stdout(stream-json) ──▶ Parser ──▶ DB ──▶ SSE ──▶ UI
```

Der neuralgische Punkt ist der Pfeil `claude-CLI … stdout … Parser`. Alles hängt
daran, dass `msb exec` einen langlebigen Prozess **zuverlässig startet, live
streamt, sauber killt und isoliert**. Genau das tut es nachweislich **nicht** von
Haus aus — wir mussten jeden dieser vier Punkte einzeln reparieren.

**Optionen, die wir bewerten müssen:**

- **A) Bei msb bleiben, aber Transport wechseln:** Statt langlebigem `msb exec`
  einen **persistenten Agent-Daemon in der VM** laufen lassen, der über
  HTTP/WebSocket zum Host streamt (nicht über die exec-stdout-Pipe). Damit
  entfallen: stdout-Pufferung, Session-Vermischung, Orphan-Kill, PID-Namespace-
  Probleme. msb wird nur noch fürs Netz-/Dateisystem-Sandboxing genutzt, nicht
  als Prozess-Transport.
- **B) msb ganz in Frage stellen:** Ist die Isolation den Preis wert? Alternativen
  wären andere MicroVM-/Container-Runtimes mit besserem exec-Streaming, oder
  (weniger Isolation) Prozess-Sandbox auf dem Host.
- **C) Agent-Ebene wechseln:** Statt der `claude`-**CLI** über eine Pipe das
  **Claude Agent SDK** direkt einbetten (der Server spricht die API selbst,
  Tool-Ausführung in der Sandbox). Dann gibt es keinen stdout-Stream-Parser mehr,
  und "Streaming" ist ein SDK-Feature statt eine Pipe-Wette.

Mein Bauchgefühl nach dieser Session: **A oder C.** Der stdout-Pipe-Transport
über `msb exec` ist die Wurzel der meisten Schmerzen. Solange der bleibt, werden
wir weiter Pflaster stapeln.

---

## Offene Verdachtspunkte für "gerade gestartet, wieder nichts"

Konnte ich diesmal **nicht live prüfen** (Bash-Zugriff temporär blockiert). Was
ich anhand des Verlaufs zuerst prüfen würde, sobald es wieder geht:

1. **Läuft der Egress-Proxy (4010)?** Wenn nicht (z. B. alter Server ohne die
   neue Startzeile), hängt claudes Start wieder ~180 s. → Serverlog auf
   "Egress-Proxy für VMs auf Port 4010" prüfen.
2. **Ist es der Kaltstart des Projekts?** Erster Turn eines _neuen_ Projekts:
   frische VM + First-Run. Sollte mit 4 CPUs ~5 s sein — aber unter Last länger.
3. **Rest-Flakiness von msb exec** (nie ganz geklärt): exec liefert nichts, der
   Prozess wartet. Auto-Retry sollte greifen, aber wenn _beide_ Versuche in die
   Flakiness laufen → Fehler statt Antwort.
4. **Läuft überhaupt der neue Server-Stand?** Wenn ein alter `bun run dev`-
   Prozess von vor den Fixes noch lief (ich hatte oft mehrere gestartet/gekillt),
   dann greifen `--stream`, Egress-Proxy etc. gar nicht. → sicher `bun run
shutdown`, dann _einmal_ frisch `bun run dev`.
5. **Egress erneut serverseitig tot?** Der msb-Egress-Bug war real; falls der
   Proxy-Pfad in der VM-Env nicht ankommt (`HTTPS_PROXY`), hängt es wieder.

---

## Empfehlung für die nächste Session

1. **Erst der echte Härtetest, dann Entscheidungen.** Frischer `shutdown` →
   _ein_ `dev` → Browser auf → 8–10 Turns über 2–3 Projekte, kalt und warm, und
   **live protokollieren** (pro Turn: Zeit bis erstes Event, Streaming-Abstände,
   Erfolg/Fehler). Ohne mein paralleles Herumstochern in der VM.
2. **Wenn dabei wieder Hänger auftreten:** nicht sofort patchen, sondern die
   Ursache dem msb-exec-Transport zuordnen (Punkt A/C oben) und die
   Architektur-Frage entscheiden, bevor weitere Pflaster kommen.
3. **Tests gegen echtes msb** (nicht nur Fake-Provider) für den einen kritischen
   Pfad, sonst bleibt die CI blind fürs eigentliche Problem.

---

## Fazit in einem Satz

Wir haben viele _echte_ Bugs gefunden (Egress, `--stream`, Ports sind reale
Root-Causes), aber die schiere Zahl der Workarounds um `msb exec` zeigt: **das
Problem ist überwiegend die Architektur des Agent-Transports, nicht nur einzelne
Bugs** — und meine "getestet, alles grün"-Zusagen waren zu optimistisch, weil sie
die realen Bedingungen deiner Nutzung nicht abgebildet haben.
