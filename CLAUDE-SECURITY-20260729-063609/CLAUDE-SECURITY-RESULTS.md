# Security-Scan 3 — macvibes

**Stand:** 2026-07-29 · **Branch:** `security/haertung-26-findings` · **HEAD:** `34939c69`

## Zusammenfassung

|               | Hauptlauf | Lückenläufe | Summe                |
| ------------- | --------- | ----------- | -------------------- |
| Kandidaten    | 32        | 20          | 52                   |
| **Bestätigt** | 11        | 6           | **17** → 13 Ursachen |
| Verworfen     | 21        | 14          | 35                   |
| Ohne Urteil   | 0         | 0           | **0**                |

Dieser Bericht ist **vollständig verifiziert**. Jeder Kandidat wurde von drei
unabhängigen, adversarial angesetzten Linsen geprüft (Code-Wahrheit /
Ausnutzbarkeit / Geltungsbereich); ein Kandidat überlebt nur bei Stimmenmehrheit
_für_ den Befund.

Der Weg dahin: Der ursprüngliche Scan-Workflow starb dreimal am Session-Limit,
weil seine Forscher-Matrix (Komponente × Kategorie = 118 Forscher × 2 Retries)
das Budget vor dem Panel aufbrauchte. Die Lösung waren **handgeschnittene
Aufträge in drei Chargen**: 14 Forscher statt 118, Ergebnis nach jeder Charge auf
Platte. Ergebnis der Umstellung: 74 Agenten, **null Ausfälle**, 2,8 M Token.

> ⚠️ **Grenze der Methode:** Bei Grenzfällen ist das Panel nicht reproduzierbar.
> `leaveProject` wurde von drei Forschern gefunden und dreimal unterschiedlich
> beurteilt (1:2, 3:0, 2:1). Klare Fälle (3:0) sind belastbar, 2:1-Fälle sind
> Münzwürfe — sie stehen unten in einer eigenen Kategorie.
>
> Zweite Grenze: Geprüft wurde gegen den **Code**, nicht gegen eine laufende
> Instanz. Bei H1 hat die Code-Linse selbst angemerkt, dass sich das reale
> Bind-Verhalten der externen `msb`-CLI im Repo nicht verifizieren lässt.

---

## Bestätigte Befunde

### H1 (HIGH) — VM-Dev-Server auf `0.0.0.0` umgeht Auth _und_ Cookie-Filter

`apps/server/src/sandbox/microsandboxProvider.ts:181` — Kandidaten C22 + C31, je 3:0

Jede Projekt-VM wird mit `-p 0.0.0.0:${hostPort}:${previewPort}` gestartet. Der
Port ist damit direkt aus dem LAN erreichbar — und umgeht beide Kontrollen, die
das Preview-Gateway aufbaut:

1. **Auth-Bypass.** `previewGateway.ts:238` verweigert ohne Session-Cookie mit
   401 (F19 aus Scan 1). Der direkte Port kennt diese Prüfung nicht →
   **anonymer LAN-Zugriff auf jede laufende Preview.**
2. **Session-Diebstahl.** `sanitizeUpstreamHeaders` (`previewGateway.ts:105-122`)
   entfernt `macvibes_session` auf dem Weg in die VM — mit genau der Begründung,
   dass Cookies nicht portgebunden sind (F2 aus Scan 1). Am Direktport fehlt
   dieser Filter, der untrusted Dev-Server bekommt den Token jedes Betrachters.

Der Port ist nicht zu raten: `portService.ts:41-49` bevorzugt den Template-Port
(5173), und `previewHostPort` wird jedem angemeldeten Nutzer per GraphQL
geliefert (`schema/index.ts:74-77`).

**Die LAN-Bindung hat keine Funktion mehr.** Das Gateway spricht die VM nur über
`127.0.0.1` an (`previewGateway.ts:271`), die iframe-URL zeigt ausschließlich
aufs Gateway (`PreviewModel.ts:52/59`), und `previewHostPort` wird im Web-Client
zwar abgefragt (`ProjectsStore.ts:28,68`), aber **nie zu einer URL verbaut**.

_Fix:_ `0.0.0.0` → `127.0.0.1`. Einzeiler. Zusätzlich ist das
Akzeptanzkriterium zu R7 (`REQUIREMENTS.md:191-195`, „das iframe zeigt direkt
auf diesen Port") veraltet — es beschreibt den Zustand vor dem Gateway und muss
nachgezogen werden.

### H2 (MEDIUM) — Sandbox kann das Session-Cookie des Betrachters überschreiben

`apps/server/src/http/cookies.ts:31,60` — Kandidaten C13 + C26, je 3:0
(bestätigt den offenen Kandidaten **F10** aus Scan 2)

`macvibes_session` wird ohne `__Host-`-Präfix, mit `path: '/'` und
`sameSite: 'lax'` gesetzt. Das Gateway filtert zwar `Set-Cookie`-**Header** der
VM (`previewGateway.ts:130-144`), aber der **Body** geht ungefiltert durch
(`:290`), und es gibt nirgends einen CSP-Header. Agent-geschriebenes JS in der
Preview läuft dank `sandbox="allow-scripts allow-same-origin"`
(`ChatPage.tsx:539`) auf einer same-site Origin und kann per
`document.cookie` ein zweites `macvibes_session` setzen. `readSessionToken`
(`cookies.ts:30-33`) nimmt einfach den ersten Treffer, ohne Dedup →
Session-Fixation.

### H3 (MEDIUM) — Unauthentifizierte Registrierung mit Admin-Bootstrap

`apps/server/src/services/authService.ts:98` — Kandidat C16, 3:0
(bestätigt den offenen Kandidaten **F5** aus Scan 2)

`istErsterAdmin = admins.length === 0 && (bootstrapName === null || …)` —
solange keine Admin-Zeile existiert und `MACVIBES_ADMIN_USERNAME` nicht gesetzt
ist (Default), bekommt **wer zuerst registriert** `role: 'admin'`,
`approved: true` und sofort eine Session (`:112`). Der Server bindet `0.0.0.0`
(`config.ts:151`), das Zeitfenster steht also dem ganzen LAN offen.

### H4 (MEDIUM) — Unauthentifizierter Login füllt den Rate-Limiter dauerhaft

`apps/server/src/schema/index.ts:307` — Kandidaten C5 + C14, je 3:0

`assertWithinLimit(loginLimiter, [… , \`user:${args.username.toLowerCase()}\`])`läuft ohne Auth und ohne Längenprüfung.`rateLimiter.ts:38-45`speichert den
Angreifer-String als Map-Key und räumt **nur** im Zweig`if (hits.size > 1000)`
auf — wenige, sehr große Keys bleiben also prozesslebenslang liegen.

### H5 (MEDIUM) — Credential-Proxy puffert den Body unbegrenzt

`apps/server/src/http/anthropicProxy.ts:206` — Kandidat C19, 3:0

`await request.text()` materialisiert den kompletten Body, der danach **zweimal**
geparst wird (`:39` und `:152`). Kein Size-Limit. Quelle ist die per Design
untrusted VM (`vmAgentEnv.ts:30-31`).

### H6 (LOW) — Subscription prüft die Session nur einmal

`apps/server/src/schema/index.ts:251` — Kandidat C2, 3:0

`requireUser` läuft beim Aufbau des Iterators genau einmal; der per-Event
`resolve` (`:253`) prüft nichts mehr. Ein Nutzer, dessen Session gelöscht wurde
(Logout, Ablauf, Admin-`rejectUser`), empfängt weiter Live-Agent-Output.

### H7 (LOW) — Kaputtes Percent-Encoding wirft vor der Auth

`apps/server/src/http/previewGateway.ts:40` — Kandidat C24, 3:0

`decodeURIComponent` in `cookieValue` ohne `try/catch`. Der Aufruf steht im
Argument der Auth-Prüfung (`:238`), wird also **vor** ihr ausgewertet → ein
unangemeldeter Request mit `Cookie: macvibes_session=%ZZ` löst einen
unbehandelten `URIError` aus.

### H8 (LOW) — Log-Injection aus der Sandbox

`apps/server/src/agent/agentGateway.ts:51` — Kandidat C25, 2:1

`url.searchParams.get('sandbox')` ist percent-dekodiert (`%0A` überlebt als
echtes LF) und geht wörtlich in `console.warn`. Erreichbar über den öffentlichen
Listener (`index.ts:325-326`).

---

## Befunde aus den Lückenläufen

### H9 (HIGH — Panel sagte MEDIUM) — Credential-Proxy reicht den Gast-Pfad ungeprüft weiter

`apps/server/src/index.ts:334` + `apps/server/src/http/anthropicProxy.ts:235` — 3:0

Die Kette, selbst nachgelesen und bestätigt:

1. `/anthropic/*` wird per **Präfix**-Match angenommen; der Rest des Pfades samt
   Query wird 1:1 übernommen (`index.ts:334`).
2. Der Gast wählt den Upstream selbst über das `model`-Feld im Body. Die
   Catch-all-Route hat `prefix: ''` (`anthropicProxy.ts:180-188`) und matcht damit
   **jedes** Modell; sie existiert per Default, weil `config.ts:191`
   `MACVIBES_LOCAL_UPSTREAM_URL ?? 'http://localhost:8787'` setzt.
3. `upstreamUrl + upstreamPath` wird **konkateniert, ohne Allowlist**
   (`anthropicProxy.ts:235`) und mit Methode, Headern und Body des Gastes
   gefetcht (`:238`). Einzige Hürde ist `verifyToken` (`:197`) — das Token hat
   der Gast legitim.

Zwei Folgen:

- `{"model":"qwen…"}` + beliebiger Pfad → der Host holt
  `http://localhost:8787/<Gastwahl>`. Das ist freier HTTP-Zugriff der untrusted
  VM auf einen **auth-losen Host-Loopback-Dienst** (`litellm_config.yaml:40`
  `master_key: null`, gebunden an `127.0.0.1` in `local-router/run.sh`) — genau
  das Ziel, das `egressPolicy.ts:5-9` bewusst sperrt. Der Credential-Proxy wird
  zur Umleitung um die eigene Egress-Sperre.
- `{"model":"claude-…"}` + beliebiger Pfad → der Host hängt das Abo-Token an
  (`:228`) und fetcht die **volle Anthropic-API-Fläche**, nicht nur Inferenz.

Zur Zeit des Scans lauschte LiteLLM tatsächlich auf `127.0.0.1:8787` (per
`lsof` geprüft) — der Pfad ist nicht theoretisch.

**Abweichung vom Panel:** Es hat MEDIUM vergeben. Nach dem Bedrohungsmodell
(„die VM-Grenze IST die Sicherheitsgrenze") durchbricht der Gast hier eine
Grenze über einen Pfad, der eigens gebaut wurde, damit er das Token nie sieht —
das ist HIGH.

_Fix:_ Pfad gegen eine Allowlist prüfen (`/v1/messages`, `/v1/models`) statt zu
konkatenieren; Methode auf POST/GET beschränken.

### H10 (MEDIUM) — Host-Probe folgt VM-kontrollierten Redirects (SSRF)

`apps/server/src/sandbox/httpProbe.ts:8` — 3:0

`await fetch(url, { method: 'GET', signal: … })` ohne `redirect: 'manual'`, also
Spec-Default `follow`. Aufrufer ist der Host (`microsandboxProvider.ts:215`),
Ziel ist der Dev-Server **in** der untrusted VM — Statuszeile und `Location`
sind damit angreiferkontrolliert. Antwortet die VM `302 Location:
http://127.0.0.1:2019/…`, stellt der Host-Prozess diese Anfrage und umgeht damit
dieselbe Sperre wie H9. Der Codebase kennt das Gegenmittel und setzt es an der
anderen Stelle korrekt (`previewGateway.ts:271` `redirect: 'manual'`).

Vorbedingung: Die VM muss ihren eigenen Status-Push abwürgen, damit die Probe
alle ~2 s feuert — für einen root-Agenten in der VM trivial. Rückkanal ist nur
ein Boolean, also ein Port-Scan-Orakel, kein Datenabfluss.

### H11 (MEDIUM) — `leaveProject` ohne Ownership-Prüfung

`apps/server/src/schema/index.ts:416` — von drei Forschern gefunden, 6:3 über
drei Panels

`requireUser` + `getProjectAny` (bewusst ohne Ownership) → `sandboxManager.leave`.
`leave()` ist **kein Viewer-Refcount**, sondern stellt bedingungslos den
Grace-Timer scharf (`sandboxManager.ts:118-122`); dessen Ablauf ruft `stop()` und
davor `onBeforeStop` — den Auto-Commit in den Branch des fremden Projekts
(`index.ts:195-201`).

Entscheidend ist nicht das Ermessen des Panels, sondern dass der Code die Regel
selbst festhält. Bei `deleteProject` steht wörtlich:

> `// ERST autorisieren, DANN erst Seiteneffekte (F10): der Stopp löst`
> `// einen Auto-Commit im fremden Branch aus und wäre sonst auch für`
> `// Nicht-Eigentümer auslösbar.` — `schema/index.ts:342-344`

`leaveProject` verletzt genau diese in Scan 1 etablierte Regel. R10 deckt das
**Starten** fremder Sandboxes, nicht das Beenden.

_Fix:_ Entweder `getProjectOwned`, oder — passend zum R10-Besuchermodell — ein
echter Viewer-Refcount pro (Projekt, Session) im SandboxManager.

## Grenzfälle (2:1 — nicht belastbar, vor einem Fix nachprüfen)

| Ort                                   | Befund                                                                                                                                                                                                                                                                               | Stimmen              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| `agent/daemon/protocol.ts:169`        | `parseAgentEvent` deckelt nur `text-`/`thinking-delta` auf 1 MiB; `tool-use`, `error`, `api-retry` haben nur `typeof === 'string'`. `MAX_MESSAGE_CHARS` greift nur in `appendDelta`, nicht in `insertMessage` → kompromittierter Daemon kann Host-DB und Abonnenten-Puffer sättigen. | 3:3 über zwei Panels |
| `sandbox/microsandboxProvider.ts:200` | Fehlgeschlagenes `waitForExecReady` hinterlässt eine laufende MicroVM mit gültigem Host-Proxy-Token (kein Cleanup).                                                                                                                                                                  | 2:1                  |
| `agent/agentGateway.ts:51`            | Log-Injection: sandbox-kontrollierter Query-Parameter wörtlich in `console.warn`, `%0A` überlebt als LF.                                                                                                                                                                             | 2:1                  |

---

## Urteil über die offenen Kandidaten aus Scan 2

| Alt                                    | Neu        | Urteil                                             |
| -------------------------------------- | ---------- | -------------------------------------------------- |
| F5 — Registrierung/Admin-Bootstrap     | C16        | ✅ **bestätigt** (3:0)                             |
| F10 — Set-Cookie aus der Sandbox       | C13/C26    | ✅ **bestätigt** (3:0)                             |
| F17/F18 — Logs                         | C25        | ✅ teilweise bestätigt (2:1); C9/C11/C21 verworfen |
| F4 — Gateway autorisiert nicht         | C23        | ❌ verworfen (0:3) — von R10 gedeckt               |
| F20 — Username-Enumeration über Timing | C8/C12     | ❌ verworfen (0:3)                                 |
| F15 — Egress-Proxy verwaist Sockets    | C20        | ❌ verworfen (1:2)                                 |
| F19 — `SAFE_GIT_ENV`                   | Lückenlauf | ❌ **verworfen** (0:3) — siehe unten               |

### F19 im Detail (der Kandidat, der am längsten offen stand)

Die Code-Beobachtung war **korrekt**: `workspaceService.ts:76` klont ohne
`SAFE_GIT_ENV`/`GIT_HARDENING`, und die Härtung hängt repo-weit nur an
`runGitInRepo` (`gitService.ts:101`) — kein zweiter Wrapper, keine prozessweite
Env-Härtung. Erreichbar ist die Stelle auch, über `copyProject` → `forkBranch`
auf einen Baum mit Agent-Commits.

Die Kette reißt aber **strukturell** am letzten Glied: Ein Filter oder Hook
müsste aus der git-Config kommen, und die kann der Gast nicht schreiben —
`--separate-git-dir` legt das `.git`-Verzeichnis außerhalb des Mounts, den die
VM beschreibt. Alle drei Linsen kamen unabhängig zu diesem Schluss.

Kein Fix nötig. Eine Härtung von `runGit` wäre trotzdem sinnvoll als
Verteidigung in der Tiefe, falls das Mount-Layout je geändert wird.

## Abdeckung

Alle beim Absturz offenen Komponenten sind nachgeholt: `agent-vm-daemon`,
`agent-host-runtime`, `sandbox-vm-lifecycle`, `server-bootstrap`, `server-db`,
`web-frontend`, `project-templates`, `ops-scripts`.

Zwei Forscher (`web-xss`, `templates`) kamen **bewusst leer** zurück — im Prompt
ausdrücklich erlaubt. Kein XSS-Sink im Frontend, kein Template-Wert, der in ein
Host-Kommando gerät.

Nicht gescannt (bewusst, laut Inventory): `node_modules`, Tests, Lockfiles,
Build-Artefakte, Dokumentation.

## Dateien

- `CANDIDATES-RAW.json` — 32 Kandidaten des Hauptlaufs mit Belegen
- `PANEL-VOTES.json` — 96 Einzelvoten des Hauptlaufs
- `BATCH1-VOTES.json` — VM-Grenze + F19 (19 Agenten)
- `BATCH2-VOTES.json` — Tokens, Status-Pfade, Lifecycle, Routing (28 Agenten)
- `BATCH3-VOTES.json` — Config, DB, Frontend, Templates, Ops (27 Agenten)

## Empfohlene Reihenfolge

1. **H9** — Pfad-Allowlist im Credential-Proxy. Bricht die VM-Grenze, Einzeiler-nah.
2. **H1** — `0.0.0.0` → `127.0.0.1`. Einzeiler, plus R7-Kriterium nachziehen.
3. **H10** — `redirect: 'manual'` in `httpProbe`. Einzeiler.
4. **H11** — `leaveProject` autorisieren (Regel aus `deleteProject` übernehmen).
5. **H2/H3** — Cookie-Präfix und Admin-Bootstrap.
6. Rest nach Severity; Grenzfälle vorher nachprüfen.

Vor dem Fixen von H1: ein `nmap`/`lsof` aus dem LAN gegen eine laufende VM
klärt in einer Minute, was am Code nicht zu klären war.
