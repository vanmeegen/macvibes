# Härtungsrunden Juli 2026 — Bilanz

Stand: 2026-08-02, `origin/main` bis `3887f45`. Vier Review-Runden
(adversarial, Multi-Agent), drei Fix-Runden, abgeschlossen mit einer
Nachverifikation ohne neue Befunde.

## Verlauf und Prozess-Lektion

| Runde           | Befunde | Davon in vorherigen Fixes | Ergebnis                                                        |
| --------------- | ------- | ------------------------- | --------------------------------------------------------------- |
| 1               | 24      | —                         | 13 Commits (`505d86c..788cad9`)                                 |
| 2               | 15      | 14                        | 6 Commits (`788cad9..d3cd216`, ungepusht gehalten)              |
| 3               | 13      | Mehrzahl                  | Fixes ungecommittet gesammelt                                   |
| 4 (Gesamtdelta) | 7       | 7                         | Fixes + Nachverifikation: **alle behoben, keine neuen Defekte** |

Die Lektion aus Runde 2/3: Jede Fix-Runde, die sofort committet und nur
punktuell geprüft wurde, baute neue Fehler in die Fixes selbst ein. Der
Wechsel auf „alle Fixes im Arbeitsbaum sammeln → EINE adversariale Review
über das komplette ungepushte Delta → Nachverifikation der Fixes durch
denselben Reviewer → erst dann committen/pushen" hat den Kreislauf beendet:
Der finale Stand ist der erste, der eine Nachverifikation ohne neue
Befunde überstanden hat.

## Probleme und Endzustand nach Subsystem

### 1. Shutdown — Auto-Commit-Verlust

**Problem:** Die Abschaltreihenfolge konnte laufende Auto-Commits
abschneiden. Ein Zwischenfix (zweites Signal → sofortiges `exit(1)`) war
eine Verschlimmbesserung, die genau das wieder einriss.

**Endzustand:** Ein zweites SIGINT/SIGTERM wartet auf die laufende
Sequenz; die Frist pro Schritt (`stepTimeoutMs`) ist die einzige harte
Schranke gegen Hänger. ✅ unit-getestet.

### 2. Agent-Daemon — verklemmter Daemon, verlorene Prompts

**Problem:** Ein abgewiesener Turn ließ den Ein-Turn-Daemon in der VM
belegt zurück. `terminate()` verschluckte das zuvor gesendete
shutdown-Frame (msb-NAT frisst FIN/RST), der automatische zweite Versuch
lief gegen denselben verklemmten Daemon.

**Endzustand:** `closeGracefully()` — Verbindung erst austragen (kein
falsches „disconnected"), dann `ws.close(4001)`, das das shutdown-Frame
nachweislich ausliefert. Der In-VM-Supervisor startet den Daemon frisch,
der Retry wartet auf die neue Verbindung und führt **denselben Prompt
automatisch erneut** aus. Der ack-Timeout-Pfad behält bewusst
`invalidate` (toter Upstream).

Dazu neu: **Re-Entry-Resume** — stirbt ein Turn vor der Antwort
(Host-Neustart, Release, weggeschossene Sandbox), ist die letzte
Chat-Zeile eine unbeantwortete User-Nachricht; beim Wieder-Öffnen des
Projekts wird genau dieser Prompt automatisch erneut ausgeführt
(originale turnId, keine doppelte User-Bubble, doppel-enqueue-fest).
✅ unit-getestet; der echte Release-Neustart-Pfad beweist sich im Alltag.

### 3. Egress-Proxy — Sicherheitsgrenze zur untrusted VM

**Problem:** Über zwei Runden vier Bugs im Streaming-Parser des
absolute-form-Pfads (Token-Leak-Fenster, Byte-Verlust bei Backpressure,
Puffer-Umgehungen), danach noch eine Header-Bombe (unbegrenzter Puffer
trotz Half-Close) und ein Race im Abbruchpfad (gepufferter Erst-Request
konnte trotz Trennung noch gesendet werden).

**Endzustand:** Redesign statt Flickwerk — explizite Phasen-Zustands-
maschine (`kopf|tunnel|einzel|zu`), genau EIN atomarer Request pro
absolute-form-Verbindung (Body per Content-Length gepuffert, erst nach
Zielprüfung gesendet, `Connection: close`, Proxy-Header gestrippt),
chunked → 411, Übergröße → 413, 8-MiB-Deckel, beidseitige Backpressure
(partielle `Socket.write`-Ergebnisse, drain, pause/resume) und eine
zentrale Terminal-Aufräumung (`macheTerminal`) in ALLEN Abbruchpfaden.
✅ 26 Tests inkl. Recorder-Origin-Beweisen („Token erreicht Origin nie").

### 4. Chat-Abbruch — „Stop heißt Stop"

**Problem:** Drei gescheiterte Anläufe mit einem Aufgeschobenen-Wunsch-
Modell (vorgemerkter Abbruch mit turnId-Ausnahme und Verfallsfenster):
Ein Stop konnte spätere, unschuldige Nachrichten abbrechen oder wirkungslos
verfallen.

**Endzustand:** Gegenwartsmodell — `activeTurnId` wird synchron vor dem
ersten await gesetzt; Stop/Interrupt wirken auf GENAU den jetzt aktiven
Turn (Startfenster per Pin auf dessen turnId, eingelöst beim
Handle-Setzen); ein Stop ins Leere ist ein bewusster No-op. Die daraus
folgende Client-Verantwortung ist umgesetzt: `ChatStore.stop()`
sequenziert hinter einen in-flight Send (sonst überholt `stopTurn` den
`sendMessage`-Resolver und verpufft — per E2E-Trace belegt).
Nutzerabbruch löst nie den Flake-Retry aus. ✅ 63 Unit-Tests, E2E grün.

### 5. Viewer-Lebenszyklus — VM stoppt nie / stoppt unterm Nutzer

**Problem:** Refcount-Leck bei Tab-Crash/Netzabriss (VM lief ewig); die
LRU-Zwischenlösung war schlechter als das Leck (verdrängte lebende
Betrachter). Danach zwei HOCH-Befunde in der Neufassung: `leave` feuerte
bei ruhigem Projekt nie (async-Generator-Suspension), und Betrachter
überlebten VM-Neustarts nicht (VM starb unter offenem Tab).

**Endzustand:** Betrachter = lebende chatEvents-Subscription. Schlüssel
serverseitig pro Subscription (`viewerKey(userId, randomUUID)`, nicht
erratbar, kollisionsfrei), `releaseOnClose` garantiert genau-einmal-leave
— synchron VOR dem Warten auf den inneren Iterator. `stop()` erhält das
Betrachter-Set, `acquire()` übernimmt Überlebende beim Neustart, ein
Abbruch während des Sandbox-Starts räumt selbst auf. LRU, `leaveProject`
und Client-viewerId (damit auch `randomId`) ersatzlos entfernt;
`enterProject`/`sendMessage` starten eager ohne Refcount
(`ensureRunning`). ✅ Schema-Level-Tests mit echtem `graphql.subscribe()`.

### 6. Begleitfunde

- `randomId`-Secure-Context-Regression (weiße Seite im LAN-http) behoben,
  das Modul nach Wegfall des letzten Konsumenten komplett entfernt.
- State-Lecks im ChatService nach `forget()` geschlossen (publish- und
  Retry-Pfad).
- `resumeUnansweredTurn` gegen Doppel-Enqueue gehärtet (zwei Tabs,
  React-StrictMode).

## Absicherung des Endstands

- Volle CI: server 605/0, web 151/0, shared 16/0, lint + typecheck sauber.
- Playwright-E2E: 33/33 (inkl. des zunächst rot gewordenen
  Stop-Button-Tests, der das Client-Race aufdeckte — Test unverändert).
- Live-Smoke-Walkthrough gegen den echten Stack (MicroVM, echter Claude,
  Preview-Gateway) auf dem neuen Stand: grün.
- Nachverifikation aller 7 Befunde der Schlussreview: behoben, keine
  neuen Defekte.

## Bewusst offen (dokumentiert, niedrig priorisiert)

- Mikrotask-Fenster in `revalidateStream`: ein `return()` vor dem
  allerersten `next()` kann den chatService-Subscriber hängen lassen
  (vorbestehend; die Viewer-Freigabe selbst ist davon nicht betroffen).
- Der Daemon-Retry unter echtem Release-Neustart ist unit-abgedeckt, der
  Alltagsbeweis steht aus.
- Akzeptierte Restrisiken unverändert: geteilte Preview-Origin (4173),
  ungefilterter Public-Egress der VM, `bypassPermissions` in der VM.
