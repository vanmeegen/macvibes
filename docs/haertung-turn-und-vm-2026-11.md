# Härtung Turn-Handling und VM-Lebenszyklus — Befunde und Plan (2026-11-25)

Auftrag: Turn-Handling sowie Start und Stopp der MicroVMs auf
Synchronisationsfehler durchsehen, im Betrieb unter Stress testen und
aufschreiben, was gefunden wurde und wie es zu beheben ist. Dieses Dokument
ändert keinen Code.

## Kurzfassung

Der Kern hält: Die Zustandsmaschine des `SandboxManager` (ein Start pro
Projekt, Stopp überholt Start, Betrachter-Zählung, Verdrängung) und die
Turn-Serialisierung des `ChatService` haben in 13 Live-Szenarien mit echten VMs
keinen Doppelstart, keine verwaiste VM und keine vermischten Chats gezeigt.

Die Fehler sitzen an den Rändern. Vier sind live nachgestellt:

| Nr. | Befund                                                  | Wirkung für den Nutzer                                                                          | Schwere |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- |
| A1  | Stirbt eine VM unter der offenen Seite, heilt nichts    | Jede Nachricht scheitert nach 60 s mit irreführendem Fehler; Anzeige bleibt „bereit"            | hoch    |
| A2  | Vorwärm-Turn kollidiert mit der ersten echten Nachricht | Erste Nachricht in einem neuen Projekt braucht ~60 s statt Sekunden                             | hoch    |
| A3  | Abbruch gibt den Turn im Daemon nicht frei              | Automatischer zweiter Versuch nach einem Hänger kann nie gelingen; Echt-VM-Test seit Langem rot | hoch    |
| A4  | Beim Herunterfahren starten noch VMs                    | VM kann den Server überleben                                                                    | mittel  |

Dazu kommen elf aus dem Code hergeleitete Befunde (B1–B11), die ich nicht live
auslösen konnte, weil sie langsame VM-Starts, Netzabrisse oder
Millisekunden-Fenster brauchen. Sie sind im Code eindeutig, aber ungetestet.

Vorgeschlagene Reihenfolge: zuerst ein Testgerüst (Paket 0), dann A1–A3
(Pakete 1–3), dann die Client-Synchronisation (Paket 4), dann der Rest.

## Was untersucht wurde

- **Code:** drei unabhängige Durchsichten (VM-Lebenszyklus, Turn- und
  Agent-Pfad, Web-Oberfläche mit Subscription), rund 5 900 Zeilen plus Tests.
  Die ranghöchsten Befunde habe ich selbst am Code nachgelesen.
- **Live:** eine getrennte Testinstallation neben dem laufenden Server
  (eigene Ports, eigene Datenbank, echte MicroVMs, echter Claude), getrieben
  von Playwright. 13 Szenarien in zwei Läufen:
  - 8× Projekt öffnen und sofort zurück; schneller Wechsel zwischen drei Projekten
  - Nachricht senden, während die VM bootet
  - Stopp sofort, per Doppelklick und mitten im Stream; Senden 40 ms nach Stopp
  - zwei Nachrichten kurz hintereinander
  - Reload mitten im Turn
  - Projekt löschen, während die VM startet (0 / 400 / 1500 ms nach dem Anlegen)
  - zwei Tabs auf demselben Projekt, einer wird geschlossen
  - VM wird von außen gestoppt, während die Seite offen ist
  - Server bekommt SIGTERM, während ein Projekt geöffnet wird
- **Experiment:** der seit Langem rote Echt-VM-Test `daemonTransport.msb` mit
  4 s Pause vor dem Folge-Turn.

Bestanden ohne Auffälligkeit: Rein/Raus, Projektwechsel, Stopp-Varianten über
die Oberfläche, zwei Nachrichten, Reload im Turn, Löschen beim Start, zwei Tabs.
Die Skripte liegen als Opt-in-Suite unter `apps/web/e2e-stress/`
(`playwright.stress.config.ts`); sie laufen nie in der CI.

Nicht geprüft: langsame lokale Modelle (Qwen), Windows, HTTPS über Caddy,
mobile Browser, mehr als drei gleichzeitige VMs, Steering (`steerOnSend`).

---

## A — Live nachgestellte Befunde

### A1 — Tote VM unter offener Seite: nichts heilt, jede Nachricht scheitert

**Nachgestellt** (zwei Läufe): VM per `msb stop` beendet, Seite offen gelassen.

Beobachtet:

- Server-Log: `Agent-Gateway … getrennt`, `Preview …: restarting` — danach
  sieben Minuten lang nichts, obwohl zwei Nachrichten gesendet wurden.
- Oberfläche: Sandbox-Status bleibt `running` („bereit").
- Jede Nachricht: nach 30 s „Der Agent-Prozess hat nicht reagiert — zweiter
  Versuch …", nach weiteren 30 s die Fehlzeile „Der Agent hat 30s lang nicht
  reagiert … mögliche Ursache: die Claude-API antwortet nicht". Die Ursache ist
  falsch benannt.
- Auch die zweite Nachricht scheitert genauso. Erst die dritte, mindestens
  zwei Minuten später, würde heilen.

Ursache (`sandbox/sandboxManager.ts:210-236`, `:588-604`): Geheilt wird nur,
wenn `vmVerschwunden` gesetzt ist oder der Preview-Status `failed` lautet.

- `vmVerschwunden` setzt allein `touchVm`, asynchron und höchstens einmal pro
  Intervall. Das Ergebnis kommt erst nach dem `ensureRunning` an, das es
  gebraucht hätte.
- Der Preview-Status einer toten VM ist `restarting`, nicht `failed`: der
  Poller macht aus einer gescheiterten Probe nach einmaligem `ready` immer
  `restarting` (`sandbox/previewStatusPoller.ts:69-79`).
- Der Abriss der Daemon-Verbindung wird nirgends als Signal gewertet.

Wann das eintritt: VM-Absturz oder OOM, Idle-Frist der VM selbst (ADR 0003),
Ruhezustand des Rechners, `msb`-Eingriff von Hand.

Fix:

1. `ensureRunning`/`enter` prüfen bei einem `running`-Eintrag die VM
   **synchron im Pfad**, wenn es Anzeichen gibt: Daemon-Verbindung getrennt
   oder Preview nicht `ready`. Dafür `touchSandbox` abwarten (kostet ~1 ms);
   `false` heißt sofort heilen (Stopp → Frischstart), nicht erst beim
   übernächsten Aufruf.
2. Der `AgentGateway` meldet einen Verbindungsabriss an den Manager
   (`noteDaemonDisconnected`). Gibt es Betrachter und kommt binnen einer
   kurzen Frist (10 s, monit startet den Daemon sonst neu) keine neue
   Verbindung, prüft der Manager die VM und heilt.
3. Die Fehlzeile unterscheidet „VM nicht erreichbar" von „API antwortet
   nicht": `TurnAttempt` fragt vor dem Schreiben den Manager.
4. `Project.sandboxStatus` zeigt während der Heilung `starting`.

Tests (vorher rot):

- `sandboxManager`-Unit: Eintrag `running`, `touchSandbox` liefert `false`,
  ein einziges `ensureRunning` → `provider.startCalls` wächst um eins.
- Unit: `noteDaemonDisconnected` mit Betrachter, Fake-Timer +10 s,
  `touchSandbox` → `false` → Neustart.
- Live (Opt-in): VM stoppen, eine Nachricht senden → Antwort kommt, keine
  Fehlzeile.

### A2 — Vorwärm-Turn kollidiert mit der ersten echten Nachricht

**Nachgestellt** (vier Vorkommen in einem Lauf): Nachricht direkt nach dem
Öffnen eines Projekts ohne bisherige Session.

Beobachtet: Chat zeigt in derselben Sekunde „Der Agent-Prozess hat nicht
reagiert — zweiter Versuch …", die Antwort kommt nach 61 s. Server-Log:
`Agent-Gateway: Verbindung von … geordnet abgebaut (Neustart)` und
`Config-Warmup … nach 60s abgebrochen`.

Ursache: `enterProject` startet für Projekte ohne Session einen Vorwärm-Turn
(`services/chat/configWarmup.ts:65-89`). Der Daemon verträgt nur einen Turn.

- Kommt die echte Nachricht, während der Warmup läuft, oder startet der Warmup
  während des ersten echten Turns (Reload, zweiter Tab), wird der zweite
  abgewiesen. Der abgewiesene Runner fordert einen Daemon-Neustart an
  (`agent/daemonRunner.ts:87-117`) und reißt damit den laufenden Turn mit.
- `prewarm` prüft `running.has` vor einem `await` und trägt sich erst danach
  ein: zwei gleichzeitige `enterProject` starten zwei Warmups. Das `finally`
  des zweiten löscht den Eintrag des ersten.

Fix:

1. `prewarm` reserviert synchron (`running.set` vor dem ersten `await`) und
   löscht im `finally` nur den eigenen Eintrag.
2. `prewarm` startet nicht, wenn ein Turn aktiv ist (Prüfung nach dem `await`).
3. Ein echter Turn, der auf einen laufenden Warmup trifft, bricht den Warmup
   ab und wartet dessen Ende ab, statt parallel zu starten — nach A3 ist der
   Abbruch sofort wirksam.
4. Der Runner behandelt die Ablehnung eines Warmups ohne Daemon-Neustart.

Tests (vorher rot):

- `Promise.all([prewarm, prewarm])` → genau ein `startTurn`.
- `sendMessage` mit hängendem Runner, dann `prewarm` → kein zweiter `startTurn`.
- Integration (Paket 0): Warmup läuft, echte Nachricht → Antwort ohne
  Retry-Zeile, kein Daemon-Neustart.
- Live: erste Nachricht in neuem Projekt unter 15 s, keine Retry-Zeile.

### A3 — Abbruch gibt den Turn im Daemon nicht frei

**Bestätigt per Experiment:** `daemonTransport.msb` scheitert seit Langem im
Fall „Folge-Turn nach Abbruch" (`turn-aborted` statt `turn-completed`). Mit
4 s Pause vor dem Folge-Turn läuft er 3 von 3 durch.

Ursache: `DaemonSession.interrupt()` setzt nur ein Flag und ruft das
SDK-`interrupt()` ohne zu warten (`agent/daemon/daemonSession.ts:187-194`).
`currentTurnId` wird erst frei, wenn das SDK-`result` des abgebrochenen Turns
eintrifft (`:265-268`). Der Host beendet seinen Stream dagegen sofort
(`agent/daemonRunner.ts:227-236`). Ein Folge-Turn in dieser Lücke läuft in die
Sperre von `startTurn` (`:117-128`) und wird abgewiesen.

Über die Oberfläche fällt das selten auf: Senden 40 ms nach Stopp hat im Test
funktioniert, weil das SDK schnell genug antwortete. Es trifft dort, wo der
Abbruch **keine** Antwort bekommt:

- **Der Watchdog-Retry kann nie heilen.** Hängt die Query, bricht
  `TurnAttempt` ab und startet Millisekunden später den zweiten Versuch
  (`services/chat/turnAttempt.ts:235`). Eine hängende Query liefert kein
  `result`, der Turn ist noch belegt, der zweite Versuch wird abgewiesen. Er
  ist der letzte, also endet der Turn mit „Turn abgebrochen". Der im Code
  beschriebene Heilungsweg (frische Query bei `resumeSessionId: null`) steht
  hinter der Sperre und ist unerreichbar.
- **Steering** (`sendMessage(interrupt: true)`, im Client per Default aus):
  jeder Vorgang kostet einen Daemon-Neustart und die Session.
- **Warmup-Timeout:** der wartende echte Turn wird abgewiesen (siehe A2).

Fix:

1. `interrupt()` gibt den Turn sofort frei wie `abandonTurn`:
   `currentTurnId = null`, Nachzügler-Sperre `verwerfeBisResult = true`,
   `turn-aborted` melden.
2. Bleibt das `result` binnen einer Frist (5 s) aus, verwirft der Daemon die
   Live-Query (`verwerfeLive`) und startet für den nächsten Turn eine frische.
   Sonst verschluckt die Nachzügler-Sperre den nächsten Turn.
3. In `startTurn` die Heilung „frische Query" vor die Ablehnungsprüfung
   ziehen, wenn der belegte Turn bereits abgebrochen ist.

Tests (vorher rot):

- `daemonSession`-Unit: `startTurn(t1)`, `interrupt(t1)`, sofort
  `startTurn(t2)`, dann das späte `result` von t1, dann Nachrichten für t2 →
  kein `turn-rejected`, t2 endet mit `turn-completed`.
- Unit: `interrupt` ohne jedes `result`, Fake-Timer +5 s, `startTurn(t2)` →
  läuft auf frischer Query.
- Integration (Paket 0): Query liefert nichts, `firstEventMs` klein → zweiter
  Versuch läuft durch.
- `daemonTransport.msb` wird ohne Pause grün.

Die bestehenden Tests `daemonSession.test.ts:178-191` und `:240` schreiben das
heutige Verhalten als Soll fest und müssen mit umgestellt werden.

### A4 — Beim Herunterfahren starten noch VMs

**Nachgestellt:** SIGTERM, 300 ms später ein Projekt geöffnet. Server-Log:
`Sandbox c0f1849a…: stopped`, direkt danach `Sandbox c0f1849a…: starting`. In
diesem Lauf blieb keine VM übrig, weil der Prozess vor dem VM-Start endete.

Ursache (`sandbox/sandboxManager.ts:559-561`, `:173-181`, `index.ts:454-469`):
`stopAll()` stoppt die Einträge, die es im Moment des Aufrufs gibt. Der
HTTP-Server nimmt weiter Anfragen an; ein `enter` oder `ensureRunning` wartet
den laufenden Stopp ab und startet dann frisch. Schafft die VM den Start vor
dem Prozessende, läuft sie ohne Server weiter, bis ihre eigene Idle-Frist
greift (45 min).

Zwei Verschärfungen derselben Wurzel:

- `stopAll` nutzt `Promise.all`: wirft ein einzelner Stopp, endet der Schritt
  sofort, während die Auto-Commits der anderen VMs noch laufen.
- Ein Start, der beim SIGTERM gerade läuft, wird voll abgewartet (bis 30 s
  Bereitschaftswarten). Reicht das Budget nicht, wird der Schritt übersprungen.

Fix:

1. Flag `faehrtHerunter`, das `stopAll()` synchron als Erstes setzt.
   `acquire()` lehnt dann mit `DomainError` „Server fährt herunter" ab, auch
   nach dem Warten auf einen Stopp.
2. `Promise.allSettled`, Fehler loggen, wiederholen, bis kein Eintrag mehr
   `starting`/`running`/`stopping` ist.
3. `waitForSandboxReady` abbrechbar machen (AbortSignal), damit ein Stopp
   einen laufenden Start nicht 30 s abwartet.

Tests (vorher rot): `enter(p1)`; `stopAll()` mit hängendem `handle.stop`;
währenddessen `ensureRunning(p1)`; Stopp auflösen → `ensureRunning` wird
abgelehnt, `provider.startCalls.length === 1`.

---

## B — Aus dem Code hergeleitete Befunde (nicht live ausgelöst)

### B1 — Abgleich löscht „Agent arbeitet", während die VM noch bootet

`apps/web/src/models/ChatStore.ts:143-156`, `:278`;
`services/projectSessionService.ts:211-212`.

Der Client setzt beim Senden `turnActive = true`. Der Server reiht die
Nachricht erst ein, nachdem `ensureRunning` fertig ist; bis dahin meldet er
`turnActive: false`. Der 5-s-Abgleich (`reconcileTurnActive`) übernimmt dieses
`false`: Arbeits-Anzeige und Stopp-Knopf verschwinden mitten im Boot, es sieht
aus, als sei die Nachricht verloren. Dauert der Start unter 5 s (im Test
370 ms), passiert nichts — deshalb nicht nachgestellt. Es trifft bei
Verdrängung, Auto-Commit vor dem Stopp und nach A1.

Zusätzlich korrigiert der Abgleich nur nach unten und prüft nach dem `await`
nicht, ob noch dasselbe Projekt offen ist:

- Ein nach Server-Neustart wiederaufgenommener Turn bleibt unsichtbar (kein
  Indikator, kein Stopp-Knopf) → Nutzer sendet doppelt.
- Die späte Antwort für Projekt A wird auf Projekt B angewandt.
- Fehlerpfade von `send`/`stop` setzen `turnActive` hart auf `false`, obwohl
  ein anderer Turn läuft; ein später Fehler aus A überschreibt Entwurf und
  Fehlermeldung in B (`ChatStore.ts:289-299`, `:323-327`).
- Server-seitig: Nach dem Turn-Ende postet der Auto-Commit-Hook eine Zeile
  mit `turnActive: true`, weil die Pump-Schleife noch läuft
  (`services/chatService.ts:564-570`). Anzeige flackert bis zu 5 s.

Fix: Der Abgleich übernimmt den Serverwert in beide Richtungen, aber nie,
solange ein Senden unterwegs ist oder eine optimistische Zeile existiert, und
nur, wenn Epoche und Projekt noch stimmen. `send`/`stop` wenden Fehlerfolgen
nur bei unveränderter Epoche an und holen `turnActive` vom Server. Der Server
publiziert beim Wiederaufnehmen ein Ereignis und nach dem Hook den Endstand.

Tests: Store-Unit mit hängendem `SendMessage` und `reconcile → false` →
bleibt `true`; Abgleich für p1 hängt, Wechsel zu p2, späte Antwort → p2
unverändert; Abgleich liefert `true` bei lokalem `false` → `true`.

### B2 — Chat verliert Zeilen bei Verbindungslücken und erholt sich nicht

`ChatStore.ts:196-241`; `schema/chatSchema.ts:59-69`;
`services/chat/chatEventBus.ts` (kein Nachliefern).

- **Lücke beim Öffnen:** Erst wird der Verlauf geladen, dann die Verbindung
  geöffnet; der Server abonniert den Bus erst nach `sandboxManager.enter`
  (bei kalter VM Sekunden). Was dazwischen geschrieben wird, fehlt.
- **Lücke beim Reconnect:** Nach einem Abriss (Tab im Hintergrund, WLAN,
  Ruhezustand) liefert der Server nur künftige Ereignisse. Streaming-Zeilen
  heilen sich, einmalige Zeilen (Tool, System, Fehler, Schlusszeile) fehlen
  bis zum Reload.
- **Scheitert die Verlaufsabfrage** einmal, bleibt der Chat halb verbunden:
  keine Verbindung, kein Abgleich, kein neuer Versuch. Eine gesendete
  Nachricht zeigt dauerhaft „Agent arbeitet", und ohne Verbindung zählt der
  Tab nicht als Betrachter — die VM stoppt nach der Grace-Frist unter ihm.
- **Dauerhaft geschlossene Verbindung:** Antwortet ein Proxy beim Reconnect
  mit 502 oder falschem Content-Type, gibt der Browser endgültig auf. Der Code
  nimmt an, es werde immer neu verbunden. (Proxy-Verhalten nicht geprüft.)

Fix: ein eigener, epochen-geschützter Verbindungszyklus.

1. Verbindung zuerst öffnen, Ereignisse puffern, nach `open` den Verlauf laden
   und per ID zusammenführen.
2. Bei jedem weiteren `open` den Verlauf erneut laden; optimistische Zeilen
   behalten.
3. Bei Fehler der Verlaufsabfrage und bei `readyState === CLOSED` mit Backoff
   neu verbinden.

Tests: Fake-EventSource feuert `error`, dann `open` → zweite Verlaufsabfrage,
neue Zeile sichtbar; Verlaufsabfrage scheitert einmal → zweiter Versuch, genau
eine Verbindung; `readyState = 2` → neue Instanz. E2E: `setOffline(true/false)`
während eines langen Turns → Antwort erscheint ohne Reload.

### B3 — Ersetzte Daemon-Verbindung lässt einen gesendeten Turn hängen

`agent/agentGateway.ts:149-157`, `:172-185`, `:208-213`;
`agent/daemonRunner.ts:72-81`.

Stirbt der Daemon mitten im Turn und meldet sich der neu gestartete an,
ersetzt der Gateway die Verbindung, ohne das dem laufenden Turn zu sagen
(bewusst, damit ein gerade startender Turn nicht grundlos abbricht). Der neue
Daemon kennt den Turn nicht; der Host wartet den Idle-Timeout ab (180 s, bei
langsamen Modellen 600 s).

Fix: eigene Meldung `replaced` bei Ersetzen und geordnetem Abbau. Der Runner
reagiert nur, wenn sein `start-turn` schon gesendet war, mit Fehler und
`turn-aborted` — der Retry übernimmt.

Test: Turn starten, Quittung liefern, `replaced` → Stream endet sofort; ein
Turn, der noch auf die Verbindung wartet, bleibt unberührt.

### B4 — Daemon bemerkt eine halbtote Verbindung nicht

`agent/daemon/gatewayConnection.ts:109`, `:120`. Der Daemon sendet Pings,
wertet ausbleibende Pongs aber nicht aus. Verschluckt das VM-Netz den Abriss,
verbindet er sich nicht neu; jeder Turn läuft in den Kaltstart-Timeout, bis
der TCP-Stack der VM aufgibt. Fix: nach zwei Intervallen ohne Pong `close()`
und Reconnect. Test mit den vorhandenen Timer-Nähten.

### B5 — Fehler beim Verarbeiten eines Ereignisses bricht den Agenten nicht ab

`services/chat/turnAttempt.ts:265-291`. Wirft `handleEvent` (Datenbankfehler),
schreibt der `catch` eine Fehlzeile, ruft aber weder `abort()` noch
`iterator.return()`. Der Agent arbeitet unbeaufsichtigt weiter, Listener und
Timer bleiben hängen, der nächste Turn wird abgewiesen. Fix: im `catch`
`rawHandle.abort()`, im `finally` `iterator.return?.()`. Test: Store wirft beim
zweiten Insert → `abort` aufgerufen, Generator beendet.

### B6 — Laufende Probe überschreibt einen neueren Preview-Status

`sandbox/previewStatusPoller.ts:63-79`, `sandbox/previewStatusPush.ts:37-45`.
Meldet der Daemon `ready`, während eine vorher gestartete HTTP-Probe noch
läuft und dann scheitert, setzt der Poller `restarting` — bis zu 2 s falsches
Overlay. Umgekehrt überschreibt eine erfolgreiche Probe ein frisches `failed`
und verzögert die Heilung. Fix: Generationszähler, den `notify()` erhöht;
`poll()` verwirft sein Ergebnis, wenn er sich geändert hat. Test mit
hängender Probe.

### B7 — Auto-Commits desselben Projekts laufen nicht nacheinander

`services/autoCommitService.ts:23-32`, `:61-69`;
`sandbox/sandboxManager.ts:444-455`. Der Commit nach dem Turn und der Commit
vor dem Stopp können gleichzeitig im selben git-Verzeichnis laufen (Shutdown,
Löschen, Idle-Stopp). Einer scheitert an `index.lock` oder „nothing to
commit" und schreibt eine falsche Fehlzeile in den Chat. Der Stand selbst geht
nicht verloren. Außerdem wird vor dem VM-Stopp committet: was der Agent in den
letzten Sekunden schreibt, landet erst beim nächsten Öffnen im Branch.

Fix: Promise-Kette pro Projekt im Committer; nach `handle.stop()` ein zweites,
billiges `saveOpenState`. Test: beide parallel mit hängendem Stub → nie zwei
gleichzeitig.

### B8 — Löschen und gleichzeitiges Öffnen hinterlassen ein Volume

`services/projectSessionService.ts:107-123`,
`sandbox/sandboxManager.ts:178-181`, `core/workspaceService.ts:66-104`. Öffnet
ein zweiter Nutzer das Projekt, während der Eigentümer es löscht, räumt der
Manager die VM ab, aber der Start hat `volumes/<id>` schon neu angelegt
(Branch-Klon, Agent-Config). Das Verzeichnis bleibt dauerhaft liegen. Fix:
Grabstein-Menge „wird gelöscht" im Manager, `acquire` lehnt ab; oder das
Löschen wiederholt das Aufräumen nach dem Nachhol-Stopp. Test mit
verschränktem Löschen und `ensureRunning`.

Heute liegt bereits ein solches Verzeichnis ohne Projekt vor:
`~/macvibes/volumes/0d2fe7f1-8549-4d68-92fb-8f3943973828`. Ob es so entstanden
ist, weiß ich nicht.

### B9 — Port-Vergabe: zwei Lücken

- **Prozess-Provider** (`sandbox/processProvider.ts:36-72`, nur Dev und E2E):
  `findFreePort` reserviert nichts. Starten zwei Projekte desselben Templates
  kurz nacheinander, bekommen beide denselben Port; die Probe des zweiten
  trifft den Server des ersten, und die Preview zeigt das fremde Projekt.
  Kandidat für E2E-Wackler. Fix: `PortAllocator` auch dort.
- **`PortAllocator.allocate`** (`sandbox/portService.ts:55-60`): Zwischen
  `reserved.has` und `reserved.add` liegt die Port-Probe mit zwei `await`.
  Verdacht, Fenster unter einer Millisekunde. Fix: synchron vor der Probe
  reservieren, bei Misserfolg freigeben.

### B10 — Hot-Reload: der alte Manager stoppt später die VM der neuen Ausführung

`sandbox/sandboxManager.ts:547-552`, `:563-576`. Nur `bun --hot`, also Dev.
`detachForReload()` löscht die vorhandenen Timer, verhindert aber keine neuen:
ein nachlaufendes Agent-Ereignis des alten `ChatService` armiert einen frischen
Idle-Timer, der 30 min später die inzwischen übernommene VM stoppt und ihr
Token entwertet. Fix: Flag `abgekoppelt`; danach sind `touch`, `armGrace` und
die Timer-Callbacks wirkungslos und `acquire` lehnt ab.

### B11 — Kleinere Punkte

| Punkt                                                                                                 | Ort                                                                  | Fix                                                                     |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Gelöschtes Projekt bei offenem Tab: Stopp-Knopf und Fortschritt bleiben, Senden ist ein stiller No-op | `ChatPageModel.ts:96-99`, `ChatStore.ts:244-254`                     | im Null-Zweig `chatStore.reset()`, Composer nur bei vorhandenem Projekt |
| Entwurf wandert beim Projektwechsel mit                                                               | `ChatStore.ts:189-195`                                               | Entwurf pro Projekt oder beim Wechsel leeren                            |
| Fehlerbanner der Übersicht klebt auf der Chat-Seite                                                   | `ProjectsStore.ts:258-284`, `:354-364`                               | erfolgreicher `refresh` löscht Lade-/Enter-Fehler                       |
| Bus-Abonnent bleibt, wenn die erste Revalidierung scheitert                                           | `schema/chatSchema.ts:99-100`, `revalidateStream.ts:23`              | Quelle im Früh-Return schließen                                         |
| Ein werfender Stopp trifft Unbeteiligte (`enter`, Verdrängung)                                        | `sandboxManager.ts:179`, `:659`                                      | `stopPromise.catch`, in der Verdrängung loggen und weiter               |
| Nach dem Warten auf einen Stopp nur einmal geprüft                                                    | `sandboxManager.ts:178-181`                                          | `while` statt `if`                                                      |
| Idle-Timer prüft `isBusy` nicht                                                                       | `sandboxManager.ts:566-574`                                          | wie beim Grace-Timer prüfen                                             |
| `forget()` im Startfenster eines Turns startet ihn für ein gelöschtes Projekt                         | `chatService.ts:597`, `turnAttempt.ts:152-208`                       | `forget` setzt den Abbruch-Pin                                          |
| Eingereihte zweite Nachricht bleibt nach Server-Absturz unbeantwortet                                 | `chatService.ts` (`resumeUnansweredTurn` sieht nur die letzte Zeile) | alle unbeantworteten Nutzerzeilen seit der letzten Antwort aufnehmen    |
| Später Fehlertext kommt nie an: `drainForErrorDetail` ist mit dem Daemon-Runner wirkungslos           | `turnAttempt.ts:384`                                                 | nach A3 kurze Nachlauffrist für Fehlerereignisse                        |
| Abgebrochener Erst-Klon gilt als vollständiger Workspace                                              | `core/workspaceService.ts:70`                                        | Marker-Datei nach erfolgreichem Klon (nicht geprüft, Absturzsicherheit) |

---

## Was solide ist

Live bestätigt oder durch vorhandene Tests gedeckt:

- Ein Start pro Projekt; ein Stopp überholt einen laufenden Start; `enter`
  während `stopping` wartet.
- Betrachter-Zählung an der Subscription: zwei Tabs sind zwei Betrachter, die
  VM bleibt, solange einer offen ist, und stoppt nach der Grace-Frist.
- Löschen während des Starts hinterlässt keine VM (dreimal mit verschiedenen
  Verzögerungen).
- Ein Turn pro Projekt; der Auto-Commit nach dem Turn läuft vor dem nächsten.
- Stopp wirkt nur auf den aktiven Turn; Doppelklick und Stopp ins Leere sind
  folgenlos; ein Nutzerabbruch löst keinen Retry aus.
- Projekt-Trennung im Client (`connectEpoch`): nach 12 schnellen Wechseln
  gehörten Chat und Preview zum richtigen Projekt.
- Reload mitten im Turn: Antwort erscheint, kein hängender Indikator.
- Polling gehört der Seite, die es gestartet hat (Fix vom 2026-11-25, kein
  Geschwisterfehler gefunden).

## Umsetzungsplan

Jedes Paket: Test zuerst (rot), Implementierung, `bun run ci`, E2E, am Ende
die Live-Suite; ein Commit pro Befund.

### Paket 0 — Testgerüst (Voraussetzung für 1–3)

1. **Integrations-Naht Host↔Daemon ohne VM:** `ChatService` + `TurnAttempt` +
   `DaemonAgentRunner` + `AgentGateway` + `DaemonSession` in einem Prozess,
   verbunden über einen In-Memory-Socket, mit skriptbarer Fake-Query (liefert
   nichts, liefert spät, wirft). Heute verdrahtet kein Test diese Kette; die
   `ChatService`-Tests nutzen Runner, deren `abort` synchron wirkt — genau die
   Annahme, die in A3 nicht gilt.
2. **Stress-Suite als Opt-in:** die 13 Szenarien liegen schon unter
   `apps/web/e2e-stress/`. Es fehlt ein Skript, das die Testinstallation auf
   eigenen Ports startet, den Testnutzer anlegt und danach aufräumt
   (`PORT=4100 MACVIBES_EGRESS_PORT=4110 MACVIBES_PREVIEW_GATEWAY_PORT=4273
MACVIBES_GRACE_MS=8000`), und die Szenarien zu A1–A4 müssen von
   „beobachten" auf harte Erwartungen umgestellt werden. Nicht in der CI
   (echte VMs, echter Claude).
3. **Fehler-Nähte im Provider:** `startDelayMs` und `failNextStart` im
   Fake-Provider der E2E-Suite, damit langsame Starts (B1) und Startfehler
   ohne echte VM in der CI prüfbar werden.

### Paket 1 — A3 Abbruch gibt den Turn frei

Zuerst, weil A2 und der Watchdog-Retry davon abhängen. Danach ist
`daemonTransport.msb` grün und kann als Pflichtlauf vor Releases gelten.

### Paket 2 — A2 Vorwärm-Kollision

### Paket 3 — A1 Tote VM heilen, Fehlermeldung richtigstellen

Zusammen mit B6 (Poller), weil beide den Preview-Status als Signal schärfen.

### Paket 4 — Client-Synchronisation: B1 und B2

Ein gemeinsamer Umbau des `ChatStore`: epochen-geschützter Verbindungszyklus
und bidirektionaler Abgleich. Dazu die kleinen Client-Punkte aus B11.

### Paket 5 — Transport-Robustheit: B3, B4, B5

### Paket 6 — Herunterfahren und Aufräumen: A4, B7, B8, B10, Manager-Punkte aus B11

### Paket 7 — Port-Vergabe: B9

## Offene Fragen

- **Idle-Frist der VM (ADR 0003):** Soll eine VM, die ihre eigene Idle-Frist
  erreicht, vom Host aktiv erkannt werden (Paket 3 deckt das ab), oder soll
  die Frist bei offenem Tab gar nicht greifen?
- **Vorwärmen:** Der Warmup spart Sekunden beim ersten Turn, hat in dieser
  Untersuchung aber viermal 60 s gekostet. Nach Paket 2 messen, ob er sich
  noch lohnt; sonst abschalten.
- **Steering:** bleibt per Default aus. Nach Paket 1 erneut prüfen, ob die
  Session den Abbruch wirklich überlebt.
