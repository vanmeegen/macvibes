# Security-Härtung macvibes: alle 26 Findings schließen

## Context

Der Claude-Security-Scan vom 25.07.2026 (Commit `a9221e7`, Effort `high`, 232 Dateien,
49 Kandidaten → 26 verifizierte Findings, 23 widerlegt) hat **9 HIGH, 13 MEDIUM,
4 LOW** gefunden. Bericht:
`/Users/marco/projects/macvibes/CLAUDE-SECURITY-20260725-095652/CLAUDE-SECURITY-RESULTS.md`.

Das Bedrohungsmodell: Der Agent in der MicroVM ist per Design **nicht vertrauenswürdig**
(Claude Code mit `permissionMode: 'bypassPermissions'`, Netzzugang, installiert Pakete).
Die VM-Grenze ist die Sicherheitsgrenze. Der schwerste Befund (F1) durchbricht genau
diese Grenze: Der Host führt git in einem Verzeichnis aus, dessen `.git` der Gast
beschreiben kann → Hooks laufen als Host-User, mit Zugriff auf `apps/server/.env`.

**Zwei eigene Messungen, die den Plan tragen:**

1. In der Sandbox existiert **kein git-Binary** (verifiziert per `msb exec`: nichts in
   `/usr/bin`, `/usr/local/bin`, `/bin`, PATH vollständig). Die Baseline installiert per
   apt nur `tini` und `monit`. Der Agent hat git also nie benutzt → das `.git` aus dem
   Mount zu nehmen kostet **keine Funktionalität**.
2. Eine gast-kontrollierte `.git`-**Datei** (wie `git worktree` / `--separate-git-dir`
   sie hinterlassen) genügt, um den Host auf einen fremden gitdir samt Hooks umzulenken.
   Im Test lief der Hook sogar bei einem Commit, der mit „nothing added to commit"
   fehlschlug. Mit explizitem `--git-dir`/`--work-tree` lief er **nicht**;
   `-c core.hooksPath=/dev/null` blockt ebenfalls; ein `.gitattributes` mit
   `filter=evil` ohne Config-Eintrag ist wirkungslos.

**Ist-Zustand der Instanz** (relevant für Migration): 1 Admin (`marco`), 3 Nutzer,
32 aktive Sessions, 11 Projekte, **11 Volumes mit `.git` im Workspace**,
`apps/server/.env` ist `-rw-r--r--`, Account `browsertest` existiert wirklich.

## Entscheidungen (vom Nutzer bestätigt)

| Frage                     | Entscheidung                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Preview-Gateway           | **Session-Pflicht.** Jeder angemeldete Nutzer darf jede Preview sehen (konsistent zur `enterProject`-Lockerung), Unangemeldete nicht. |
| Fehlendes microsandbox    | **Server startet gar nicht**, wenn er ohne Isolation echte Agent-Turns fahren würde.                                                  |
| Account `browsertest`     | **Löschen** (Account + Literal im Repo).                                                                                              |
| Schnitt                   | **Ein Branch, pro Arbeitspaket ein eigener Commit**, jeder einzeln `bun run ci`-grün.                                                 |
| git-Tools für den Agenten | **Vertagt** — nur die Absicherung, keine MCP-git-Tools.                                                                               |

---

## AP0 — Operative Sofortmaßnahmen (kein Code)

Vor dem ersten Commit auf dem Host auszuführen:

1. **Verwaiste VM stoppen**: `macvibes-116628b7-4349-4532-8acb-a05c72714b7f` läuft seit
   dem 16.07., hat den Server-Neustart überlebt und wird von keinem `SandboxManager` mehr
   verwaltet → `msb stop` + `msb rm`.
2. **`chmod 600 apps/server/.env`** (F26, siehe AP8).
3. **Account `browsertest` löschen** (F15) — über die Admin-UI bzw. `rejectUser`.

---

## AP1 — git-Absicherung (F1) · größter Hebel, keine Abhängigkeit

**F1 — Gast-beschreibbares `.git` → Host-RCE.** `microsandboxProvider.ts:163-164` mountet
den Workspace samt echtem `.git` **read-write** nach `/work`, und der Host führt danach in
genau diesem Verzeichnis `git add -A` / `commit` / `push` ohne Härtung aus
(`autoCommitService.ts:22-34`, `gitService.ts:16-21`). Ein vom Agenten geschriebener
`.git/hooks/pre-commit`, ein `core.fsmonitor` oder eine `ext::`-Remote-URL läuft damit als
Host-User — automatisch nach jedem Turn und vor jedem Sandbox-Stopp.

**Wie es geschlossen wird:** Die git-Metadaten wandern aus dem Mount heraus nach
`<volume>/git`, und **jeder** host-seitige git-Aufruf auf Projektebene übergibt
`--git-dir`/`--work-tree` explizit, macht also keine Repo-Discovery mehr durch den
gast-beschreibbaren Baum. Die Härtungs-Flags kommen als zweite Reihe dazu, falls später
jemand einen Aufruf ohne explizite Pfade ergänzt.

**Änderungen**

- `workspaceService.ts`: neu `gitDirFor(macvibesHome, projectId)` → `<volume>/git` und
  `projectRepoFor(...)` → `{ gitDir, workTree }`.
- `workspaceService.ts:45-61` `ensureWorkspace`:
  - Existenz-Kriterium von `existsSync(join(dir,'.git'))` auf `existsSync(join(gitDir,'HEAD'))`
    umstellen — das alte Kriterium ist gast-fälschbar.
  - **Migration** bestehender Volumes: ist `<workspace>/.git` ein Verzeichnis und
    `<volume>/git` fehlt → `renameSync` (gleiches Dateisystem, `origin` zeigt bereits aufs
    Bare-Repo, bleibt gültig).
  - Frischer Klon mit `--separate-git-dir <gitDir>`, danach die von git hinterlassene
    `.git`-Datei löschen.
  - **Immer** (auch im Bestandsfall) `<workspace>/.git` entfernen, falls vorhanden — der
    Gast kann sie jederzeit neu anlegen. Vorkommen loggen, aber nicht werfen, sonst kann
    der Gast den Auto-Commit per DoS abschalten.
- `gitService.ts`: neu `runGitInRepo(repo: ProjectRepo, args: string[])`, das immer
  `git --git-dir=<gitDir> --work-tree=<workTree> -c core.hooksPath=/dev/null
-c core.fsmonitor=false -c core.attributesFile=/dev/null -c protocol.ext.allow=never`
  aufruft, mit `cwd = workTree` (wegen Pathspec-Semantik von `add -A`) und gescrubbter Env
  (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_ASKPASS=/bin/false`, `GIT_DIR`/`GIT_WORK_TREE`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`
  gelöscht). Vorbedingung: `gitDir` muss unter `macvibesHome` liegen, sonst `GitError`.
  Das bestehende `runGit` bleibt für Bare-Repo-Operationen (`gitService.ts:36/40/108/113`,
  `mirrorService.ts`) — die laufen nie in gast-beschreibbaren Verzeichnissen.
- `autoCommitService.ts:22-34`: Signatur auf `autoCommit(repo: ProjectRepo, message)`,
  alle vier Aufrufe auf `runGitInRepo`.
- ⚠️ **`index.ts:152-153`**: Der `onBeforeStop`-Guard prüft `existsSync(join(workspaceDir,'.git'))`.
  Wird der nicht mitgezogen, fällt der Auto-Commit vor jedem Sandbox-Stopp **stillschweigend
  aus**. Das ist das höchste Regressionsrisiko im ganzen Plan.

**Test-first** (`gitService.test.ts`, `workspaceService.test.ts`, `autoCommitService.test.ts` —
echte git-Aufrufe gegen Temp-Verzeichnisse, bestehendes Muster):

- Beweis-Test: Angreifer legt `<workspace>/.git` als Datei `gitdir: <evil>` an,
  `<evil>/hooks/pre-commit` schreibt einen Marker → nach `autoCommit` existiert der Marker
  **nicht**. Vor dem Fix existiert er.
- `runGitInRepo` verweigert einen `gitDir` außerhalb `macvibesHome`.
- Nach `ensureWorkspace` existiert `<workspace>/.git` nicht, `<volume>/git/HEAD` schon.
- Migrationstest: Legacy-Volume → `.git` liegt danach unter `<volume>/git`, Dateien
  unverändert, anschließender `autoCommit` funktioniert.

---

## AP2 — Fail-closed Backend-Wahl (F9, F22)

**F9 — Stiller Rückfall auf den unsandboxed Host-Agenten.** `selectAgentRunner`
(`index.ts:193`) nimmt bei fehlendem `msb` den `ClaudeAgentRunner`, der das Agent SDK im
Hostprozess mit `permissionMode: 'bypassPermissions'` und dem Workspace als cwd fährt.
Angekündigt wird das nur durch eine Konsolenzeile — ein angemeldeter Nutzer bekommt damit
faktisch Codeausführung auf dem Mac.

**F22 — Host-`bun install` im gast-beschriebenen Workspace.** `processProvider.ts:40`
führt `bun install` auf dem **Host** in `workspaceDir` aus, dessen `package.json` der
Agent geschrieben hat. Bun führt dabei `preinstall`/`install`/`postinstall`/`prepare` aus.

**Wie es geschlossen wird:** Die Backend-Auflösung wird explizit und fail-closed:
Löst sie auf „echter Agent ohne VM-Isolation" auf, **startet der Server nicht** (Nutzer-
Entscheidung). Ein ausdrücklich gesetztes `MACVIBES_SANDBOX=process` bleibt erlaubt, solange
der Agent `fake` ist — damit bleibt der Playwright-E2E-Pfad unberührt. Für den Notfall gibt
es `MACVIBES_ALLOW_HOST_AGENT=1`. Zusätzlich läuft `bun install` nur noch mit
`--ignore-scripts`.

**Änderungen**

- Neu `sandbox/backendSelection.ts` mit reiner Funktion
  `selectBackends(env, msbPresent): { sandbox, agent }`, die im Fail-open-Fall wirft.
  Die Extraktion ist nötig, weil `index.ts` wegen Top-Level-Effekten heute nicht testbar ist.
- `index.ts:93-95, 193`: nutzt `selectBackends`, bricht mit klarer deutscher Meldung ab.
- `processProvider.ts:40`: `bun install --silent --ignore-scripts`.

**Test-first**: `backendSelection.test.ts` — kein `MACVIBES_SANDBOX` + kein msb → wirft;
`MACVIBES_SANDBOX=process` + `MACVIBES_AGENT=fake` → `process/fake` (E2E bleibt grün);
`MACVIBES_ALLOW_HOST_AGENT=1` → `host`. `processProvider.test.ts`: Template mit
`postinstall`, das einen Marker schreibt → nach `start()` kein Marker.

---

## AP3 — Preview-Gateway (F19, F2, F11, F13)

**F19 — Gateway ohne jede Authentifizierung (IDOR).** `resolveTarget`
(`previewGateway.ts:49-82`) zieht die `projectId` aus Pfad, `Referer` oder einem
ungesignten `mvp`-Cookie und proxied dann Methode und Body an die VM — zwischen dem
`0.0.0.0:4173`-Listener und dem Upstream-`fetch` gibt es keine Session-Auflösung. Wer Port
4173 erreicht (laut README teils bewusst geforwardet) und eine Projekt-ID kennt, erreicht
jede laufende Preview.

**F2 — Session-Cookie wandert in die VM.** `previewGateway.ts:150-156` kopiert alle
Request-Header und löscht nur `host` und `accept-encoding`; da Cookies nicht portgebunden
sind, hängt der Browser `macvibes_session` an jede Preview-Anfrage. Der Dev-Server in der
untrusted VM bekommt damit den Session-Token jedes Betrachters — `httpOnly` hilft nicht,
weil der Token als gewöhnlicher Header ankommt.

**F11 — VM-Antwortheader verbatim an den Browser.** `previewGateway.ts:169` übernimmt alle
Header der angreiferkontrollierten VM-Antwort, inklusive `Set-Cookie`. Weil Cookies
portunabhängig sind, kann die VM Cookies für dieselbe Site setzen, auf der die App
auf `:4000` läuft.

**F13 — Preview-iframe ohne `sandbox`-Attribut.** `ChatPage.tsx:531` bindet vom Agenten
geschriebenes HTML/JS mit echter same-site Origin ein. Das erlaubt der Preview unter
anderem, die Host-Seite wegzunavigieren (Phishing) und credentialed Requests gegen
`:4000/graphql` zu stellen.

**Wie es geschlossen wird:** Das Gateway bekommt einen `authenticate`-Callback, der das
`macvibes_session`-Cookie über `resolveSession` prüft (mit ~30 s Positiv-Cache, sonst
schreibt die rollierende Verlängerung pro Preview-Asset in SQLite) — **derselbe Check auch
im WebSocket-Upgrade-Pfad**, sonst ist die Auth über HMR umgehbar. Request- und
Antwortheader laufen künftig durch zwei reine Funktionen, die Session-/Auth-Header zur VM
hin und `Set-Cookie` des Routing-Namens sowie `Strict-Transport-Security` und
`Clear-Site-Data` zurück zum Browser entfernen. Der iframe bekommt ein `sandbox`-Attribut
**mit** `allow-same-origin` (nötig für HMR-WebSocket und `localStorage`), aber **ohne**
`allow-top-navigation` und `allow-popups-to-escape-sandbox`.

**Dateien**: `http/previewGateway.ts` (neu: `sanitizeUpstreamHeaders`,
`sanitizeDownstreamHeaders`, `authenticate` in den Options), `index.ts` (Verdrahtung mit
`resolveSession`), `apps/web/src/pages/ChatPage.tsx:531`.

**Test-first** (`previewGateway.test.ts`, Fake-Upstream via `Bun.serve({port:0})`):
Request ohne Cookie → **401** und der Fake-Upstream wurde nie kontaktiert; mit
`cookie: macvibes_session=geheim; app=1` sieht der Upstream `app=1`, aber nicht `geheim`;
antwortet der Upstream mit `set-cookie: mvp=fremd`, enthält die Client-Antwort das nicht.
Dazu reine Unit-Tests für beide Sanitizer, analog zu den bestehenden `resolveTarget`-Tests.

⚠️ **Regression**: E2E-Specs, die das Gateway ohne Login ansprechen
(`e2e/preview.spec.ts`, `preview-responsive.spec.ts`), brechen und müssen eine Session
mitführen.

---

## AP4 — Egress-Proxy: Zielpolicy und Requestline-Hygiene (F3)

**F3 — Offener CONNECT-Tunnel (SSRF).** `egressProxy.ts:42-60, 110-121` übernimmt Host und
Port ungeprüft aus der Request-Line in `Bun.connect` — keine Allowlist, keine Sperre für
Loopback oder private Netze, keine Portbeschränkung. Der Agent besitzt die Proxy-
Credentials per Design (`vmAgentEnv.ts:35`), erreicht also alles, was der Host erreicht;
der repo-eigene Test `egressProxy.test.ts:55-65` tunnelt bereits erfolgreich nach
`127.0.0.1`.

**Wie es geschlossen wird:** Vor jedem `Bun.connect` wird der Zielname auf dem Host
aufgelöst, **jede** zurückgegebene Adresse gegen eine Sperrliste geprüft (127/8, ::1, 10/8,
172.16/12, 192.168/16, 169.254/16, 100.64/10, 0.0.0.0/8, fc00::/7) und anschließend
**auf die geprüfte IP** verbunden — sonst bleibt ein DNS-Rebinding-Fenster zwischen Prüfung
und Verbindung. Ports werden auf 80/443 begrenzt (per Env erweiterbar).

**Gleiches Paket, zwingend zusammen:** Der Bericht hat einen Request-Smuggling-Kandidaten
(bare-LF im Header-Block umgeht den `/^proxy-/i`-Filter) **nur deshalb widerlegt**, weil F3
demselben Angreifer ohnehin einen unbeschränkten Tunnel gibt. Mit der Zielpolicy wird
dieser Kandidat scharf. Deshalb kommt eine strikte Kopf-Zerlegung dazu: nur `\r\n`-Paare,
kein bare `\n`/`\r`, Request-Line aus exakt drei Token, Header-Namen nach RFC-Zeichenklasse,
keine Obs-Fold-Fortsetzungen — sonst `400` und Verbindungsabbruch.

**Dateien**: neu `http/egressPolicy.ts` (reine Funktionen `isBlockedIp`, `checkTarget`),
`http/egressProxy.ts:83-95` (Kopf-Parser), `:110-143` (Policy vor beiden Connect-Pfaden).

**Test-first** (`egressProxy.test.ts`, rohe TCP-Bytes, bestehendes Muster):
`CONNECT 127.0.0.1:<port>` mit gültigem Token → heute `200 Connection Established`, nach
dem Fix `403` und kein Byte vom Ziel; `CONNECT host:22` → `403`; absolute-form auf
Loopback → `403`; Kopf mit bare-LF und zweiter Request-Line → `400`, kein Upstream-Connect;
Tabellentest über die CIDR-Klassen in `egressPolicy.test.ts`.

⚠️ **Regression**: Der Egress-Proxy ist der einzige Weg der VM ins Netz (`bun install`,
Claude-Startup). Vor dem Merge einmal ein echtes `bun add` in einer VM fahren. Das
msb-Host-Gateway `172.16.0.0/12` läuft über `NO_PROXY` (`vmAgentEnv.ts:38`) und darf im
Proxy blockiert bleiben.

---

## AP5 — Yoga-Härtung: CORS, CSRF, Fehlermaskierung (F5, F6, F24)

**F5 — Permissives Default-CORS.** `createYoga` (`index.ts:239`) wird ohne `cors`-Option
gebaut, wodurch Yoga jede Origin spiegelt und `Allow-Credentials: true` setzt. Da die
Preview auf `:4173` same-site zu `:4000` ist, greift `SameSite=Lax` nicht und die Antworten
sind für VM-JavaScript lesbar.

**F6 — Kein CSRF-Schutz auf `/graphql`.** Die Authentifizierung hängt allein am
Ambient-Cookie (`index.ts:244-249`), es gibt keine Origin-, Referer- oder
`Sec-Fetch-Site`-Prüfung, und Yogas form-urlencoded-Parser macht preflight-freie
HTML-Form-POSTs zu gültigen Mutationen.

**F24 — `maskedErrors: false` leakt Interna.** `index.ts:243` schaltet die Maskierung ab,
sodass jede `GitError`, `MicrosandboxError` oder fs-Fehlermeldung inklusive Hostpfaden und
git/msb-stderr in `errors[].message` landet.

**Wie es geschlossen wird:** Zuerst wird die Yoga-Konstruktion nach `http/createAppYoga.ts`
extrahiert — erst dadurch ist die HTTP-Ebene ohne `Bun.serve` testbar. Dann eine explizite
CORS-Allowlist (eigene Origin aus dem `Host`-Header in http+https, `MACVIBES_ALLOWED_ORIGINS`,
im Dev zusätzlich die Vite-Origin), ein kleines eigenes CSRF-Plugin, das POSTs mit
`Sec-Fetch-Site: cross-site` oder unbekannter `Origin` mit 403 ablehnt, und
`maskedErrors: true` mit `DomainError extends GraphQLError`, damit die deutschen
Nutzer-Meldungen die Maskierung überleben.

⚠️ **Zwei Fallen**: (1) Die CORS-Allowlist muss aus dem `Host`-Header abgeleitet werden,
sonst funktioniert nur `localhost` und der LAN-Zugriff stirbt. (2) Im Dev proxied Vite
`/graphql` mit `changeOrigin: true` — der Host wird `localhost:4000`, die `Origin` bleibt
`http://localhost:5173`. Ohne explizite Aufnahme des Dev-Web-Ports ist `bun run dev` tot.

**Test-first**: neu `http/__tests__/createAppYoga.test.ts` mit `createTestDb()` und direktem
`yoga.fetch(...)`: `OPTIONS` mit fremder Origin liefert kein `Access-Control-Allow-Origin`;
POST mit `Sec-Fetch-Site: cross-site` → 403 und keine ausgeführte Mutation; ein Resolver,
der einen internen Pfad wirft, liefert `Unexpected error`, während `DomainError` wörtlich
sichtbar bleibt.

---

## AP6 — Schema-Testharness, Autorisierungsreihenfolge, Rate-Limit (F10, F14)

**Vorarbeit (Infrastruktur):** Es gibt heute **keinen** Server-Test, der das GraphQL-Schema
hochzieht — Resolver hängen allein an Playwright. Neu: `schema/__tests__/schemaHarness.ts`,
das ohne HTTP direkt `graphql()` gegen das exportierte Schema fährt, mit `createTestDb()`,
`createUser()`, `createTemplatesFixture()`, einem `FakeSandboxManager` (der `enter`/`leave`/
`stop` aufzeichnet) und einem Fake-CookieStore. Damit der Fake ohne Cast passt, wird der
Context-Typ in `schema/builder.ts` von der Klasse auf ein Interface `SandboxManagerLike`
umgestellt.

**F10 — `deleteProject` stoppt fremde Sandbox vor der Ownership-Prüfung.**
`schema/index.ts:318` ruft `sandboxManager.stop()` nur durch `requireUser` geschützt; der
Owner-/Admin-Check sitzt erst in `projectsService.deleteProject:250`. Der Seiteneffekt läuft
also auch dann, wenn die Mutation danach abgelehnt wird — inklusive erzwungenem Auto-Commit
und Push fremder Arbeit.

**F14 — Kein Rate-Limit auf `login`/`register`.** Jeder unauthentifizierte `login`-Request
erzwingt ein argon2id-`verify` (`register` zusätzlich ein `hash`), ohne Zähler, Delay oder
Lockout. Ein einzelnes GraphQL-Dokument mit vielen aliasierten `login`-Feldern
multipliziert die Kosten.

**Wie es geschlossen wird:** Die Autorisierung wandert in `assertCanDeleteProject(db, user, id)`
und wird im Resolver **vor** `sandboxManager.stop` aufgerufen. Für das Rate-Limit kommt ein
reiner In-Memory-Sliding-Window (`services/rateLimiter.ts`) mit den Schlüsseln
`login:ip`, `login:user`, `register:ip`, geprüft **vor** dem argon2-Aufruf; die Client-IP
kommt über den Yoga-Server-Context aus AP5 (`server.requestIP`). Abschaltbar per
`MACVIBES_RATE_LIMIT_DISABLED=1` für E2E.

**Test-first**: Nutzer B ruft `deleteProject` auf ein Projekt von A → Mutation schlägt fehl
**und** `harness.sandbox.stopCalls` ist leer (heute enthält es die ID); Owner und Admin
dürfen weiterhin löschen. 20 fehlgeschlagene Logins in Folge → ab dem N-ten „Zu viele
Versuche", Zahl der Hash-Aufrufe bleibt gedeckelt; Fenster-Rollover mit injizierter `now()`.

---

## AP7 — Auth-Härtung (F8, F21, F23 + zwei Zusätze)

**F8 — Erster Registrant wird Admin, nicht atomar.** `register` ist unauthentifiziert
erreichbar, und bei leerer `users`-Tabelle wird der Account als `role='admin', approved=true`
angelegt und sofort mit Session versehen. Zwischen Emptiness-Check (`authService.ts:75-76`)
und Insert (`:79-88`) liegt ein `await` auf argon2, beides ist nicht transaktional — zwei
parallele Registrierungen ergeben zwei Admins.

**F21 — `ensureAdmin` befördert jeden Träger des konfigurierten Namens.**
`authService.ts:179` setzt bei jedem Boot die Zeile mit `config.adminUsername` auf
`role='admin', approved=true`, ohne zu prüfen, wer sie wann angelegt hat. Da `register` den
Namen nicht reserviert und `.env.example:53` den wahrscheinlichen Wert verrät, kann ein
Fremder ihn vorbelegen und wird beim nächsten Neustart Admin.

**F23 — Session-Cookie ohne `Secure`.** `cookies.ts:49` hat `secure: false` hartkodiert,
während das dokumentierte Deployment TLS in Caddy terminiert und der Bun-Server weiter im
Klartext auf `0.0.0.0:4000` lauscht.

**Wie es geschlossen wird:** Der Erst-Admin-Pfad wird in eine synchrone
`db.transaction` gefasst (bun:sqlite ist synchron; der Hash wird vorher berechnet) und
zusätzlich durch einen **Unique-Index** `users_single_admin ON users(role) WHERE role='admin'`
abgesichert — der Constraint ist die eigentliche Garantie. `ensureAdmin` befördert nur noch,
wenn **überhaupt kein** Admin existiert (echte Bootstrap-Semantik), sonst nur `console.warn`;
Notausstieg `MACVIBES_FORCE_ADMIN=1`. `secure` wird pro Request aus
`x-forwarded-proto`/`URL.protocol` abgeleitet, sodass LAN-http und Caddy-https gleichzeitig
funktionieren.

**Zwei Zusätze, die fachlich dazugehören** (im Bericht nicht als eigene Findings, aber in
denselben Zeilen):

- `resolveSession:186-205` prüft `user.approved` **nicht** — ein zurückgezogenes Approval
  kappt bestehende Sessions nicht. Prüfung ergänzen und Session löschen.
- `createSession:123-128` speichert den **Klartext-Token als Primärschlüssel**. Künftig
  `sessions.id = sha256(token)`; der Klartext verlässt den Prozess nur im Cookie. Das
  entwertet F7 und F25 als Eskalationspfad.

⚠️ **Migration**: Die Session-Umstellung kann bestehende Zeilen nicht umrechnen → die
Migration leert `sessions`, alle **32** aktiven Sitzungen müssen sich neu anmelden (bei
3-Tage-TTL vertretbar). Der Unique-Index ist unkritisch: die DB hat genau **einen** Admin
(`marco`); die Migration prüft das trotzdem und bricht mit klarer Meldung ab, falls mehrere
existieren.

**Test-first**: zwei parallele `register` auf frischer DB → genau einer ist Admin;
DB mit Admin `a` und `adminUsername='b'` → `b` bleibt `user`; Login mit
`x-forwarded-proto: https` setzt `secure: true`, ohne Header `false`; Session mit
`approved=false` → `resolveSession` liefert `null` und löscht die Zeile; der Cookie-Wert
steht nicht in `sessions.id`, `resolveSession` findet den Nutzer trotzdem.

---

## AP8 — Dateisystem und Dateirechte (F7, F25, F26)

**F7 — Vite-Dev-Server auf allen Interfaces ohne fs-Grenze.** `vite.config.ts:13` bindet mit
`host: true` auf `0.0.0.0` und setzt kein `server.fs`-Limit, wodurch Vites `/@fs/`-Handler
Dateien unterhalb des Repo-Roots ausliefert — darunter `apps/server/data/app.db` mit
Klartext-Session-Tokens und argon2id-Hashes. Wer im LAN Port 5173 erreicht, hat damit einen
direkten Auth-Bypass.

**F25 — SQLite-DB world-readable.** `db/client.ts:10` legt Verzeichnis und Datei mit
Prozess-Defaults an, also `-rw-r--r--` für `app.db`, `-wal` und `-shm`. Ein zweiter lokaler
Account liest darin Session-Tokens, die direkt als Cookie verwendbar sind.

**F26 — OAuth-Token in world-readable `.env`.** `apps/server/.env` enthält einen echten
`CLAUDE_CODE_OAUTH_TOKEN` und ist `-rw-r--r--` (verifiziert), alle Elternverzeichnisse
`0755`, und der README-Schritt `cp .env.example .env` erwähnt kein `chmod`.

**Wie es geschlossen wird:** Vite bekommt `server.fs.strict` mit expliziter `allow`-Liste
und einem `deny` für `**/.env*`, `**/*.db*` und `**/data/**`; der eigentliche Layering-Fix
ist aber, dass `resolveDbPath()` die DB per Default nach `<macvibesHome>/data/app.db` legt
statt unter den Repo-Root (Bestandsschutz: existiert `./data/app.db`, wird sie weiter
benutzt). `createDb` legt das Verzeichnis mit `0700` an und chmodded DB, `-wal` und `-shm`
nach dem `PRAGMA journal_mode = WAL` auf `0600`. Für `.env` prüft der Server beim Start die
Rechte und meldet sie deutlich — automatisch geändert wird eine Nutzerdatei nicht (siehe AP0).

**Test-first**: DB in Temp-Verzeichnis anlegen → `statSync(path).mode & 0o077 === 0`;
`resolveDbPath` liefert bei gesetztem `MACVIBES_HOME` und fehlender Alt-DB den neuen Pfad,
bei vorhandener Alt-DB den alten; `vite.config.ts` importieren und `server.fs.deny/allow`
assertieren (die Config ist ein reines Objekt).

---

## AP9 — Pro-VM-Token statt einem Shared Secret (F4, F12)

**F4 — Agent-Gateway-Identität ist selbstbehauptet.** `agentGateway.ts:34-49` prüft nur den
prozessweiten Token und registriert den Socket unter dem **frei wählbaren** Query-Parameter
`sandbox`, ohne Abgleich gegen existierende Sandboxes. Eine Zweitverbindung verdrängt die
bestehende (`:118-137`), sodass eine VM sich als fremdes Projekt anmelden, dessen Prompts
empfangen und gefälschte Agent-Events in fremde Chats schreiben kann.

**F12 — Ein Secret für drei Rollen, in jeder VM.** `index.ts:45` erzeugt einen einzigen
`proxyToken`, der gleichzeitig Credential-Proxy (`anthropicProxy.ts:196`), Egress-Proxy
(`egressProxy.ts:100`) und Agent-Gateway (`agentGateway.ts:38`) authentifiziert und per
`vmAgentEnv.ts:28-39` identisch in jede untrusted VM gepflanzt wird — unter anderem als
Query-Parameter in der WebSocket-URL.

**Wie es geschlossen wird:** Eine `VmTokenRegistry` stellt beim VM-Start ein Token pro
Sandbox aus (`mint`), widerruft es beim Stop (`revoke`) und löst es über einen
`sha256`-Hash-Map-Lookup wieder in die Identität auf — damit entfallen zugleich alle
naiven `!==`-Vergleiche. Das Agent-Gateway leitet die Sandbox-Identität **aus dem Token ab**
und nutzt den Query-Parameter nur noch als Konsistenzprüfung (Mismatch → 401); beide Proxies
prüfen per `lookup(token) !== null` und loggen die Identität, was nebenbei die
Egress-Zuordnung aus AP4 auswertbar macht.

**Dateien**: neu `sandbox/vmTokens.ts`; `microsandboxProvider.ts` (mint/revoke im
Lifecycle), `agent/vmAgentEnv.ts` (`proxyToken` → `vmToken`), `agentGateway.ts:34-49`,
`anthropicProxy.ts:196`, `egressProxy.ts:100`, `index.ts:45`.

**Test-first**: Verbindung mit dem Token von Sandbox A, aber `?sandbox=B` → 401, und die
Abonnenten von B bekommen nichts (heute werden sie beliefert und die echte B-Verbindung
verdrängt); ein widerrufenes Token wird von allen drei Oberflächen abgelehnt; die interne
Map enthält keinen Klartext.

⚠️ **Regression**: Der Token-Wechsel invalidiert bestehende Daemon-Verbindungen — nach dem
Deploy müssen alle VMs neu gestartet werden.

---

## AP10 — Sandbox-Lifecycle (F17, F20)

**F17 — `enter()` überschreibt einen Eintrag, dessen `stop()` noch läuft.**
`sandboxManager.ts:45-91` kurzschließt nur bei `starting`/`running`; ein Eintrag im Status
`stopping` — während `stop()` noch auf den Auto-Commit-Hook wartet — wird ersetzt und eine
neue VM unter demselben `msb`-Namen gestartet. Das alte `stop()` führt danach `msb stop`/`rm`
auf die **neue** VM aus und gibt deren Port frei.

**F20 — LRU-Eviction stoppt fremde, beschäftigte Sandboxes.**
`evictLeastActiveIfNeeded:197-211` kennt weder Eigentümer noch `isBusy` und ist über den
bewusst ungeschützten `enterProject`-Resolver für jedes Projekt erreichbar. Ein Nutzer kann
die acht Plätze mit fremden Projekten füllen und dabei laufende Turns anderer killen.

**Wie es geschlossen wird:** Der Eintrag bekommt ein `stopPromise` analog zum vorhandenen
`startPromise`; `enter` behandelt `stopping` explizit und wartet es ab, bevor es neu startet.
Die Eviction filtert beschäftigte Sandboxes heraus und wirft einen `DomainError`
(„Alle Sandbox-Plätze sind belegt und beschäftigt"), statt einen fremden laufenden Turn zu
beenden. Ownership bleibt bewusst außen vor — sonst blockiert ein einzelner Nutzer die
Kapazität; tabu sind nur **beschäftigte** Sandboxes.

**Test-first**: Provider mit langsamem `stop`; `stop(p)` ohne await starten, dann `enter(p)`
→ `provider.start` läuft erst nach Abschluss von `stop`, `onBeforeStop` wurde genau einmal
gerufen. `maxSandboxes: 1` mit beschäftigter Sandbox A → `enter(B)` wirft und A wurde nicht
gestoppt; mit `isBusy(A) === false` wird A verdrängt (Regression).

⚠️ **UI-Folge**: `enterProject` kann jetzt fehlschlagen — `ProjectsStore`/`ChatStore` müssen
die Meldung anzeigen, sonst wirkt es wie ein Hänger.

---

## AP11 — chatService-Robustheit (F16, F18)

**F16 — Unbegrenzte Delta-Akkumulation.** `parseAgentEvent` (`protocol.ts:157`) prüft nur
`typeof` ohne Längengrenze, und `appendDelta` (`chatService.ts:483`) konkateniert im
Speicher, schreibt pro Delta die **komplette wachsende Zeile** per UPDATE nach SQLite und
rebroadcastet sie an alle Abonnenten. Ein kompromittierter Daemon kann damit Speicher,
Platte und alle SSE-Verbindungen sättigen; nebenbei ist der I/O schon im Normalbetrieb
quadratisch.

**F18 — Fehlerpfad wirft → Unhandled Rejection.** `deleteProject` löscht die Projektzeile,
ohne den laufenden Turn zu stoppen; wegen `PRAGMA foreign_keys = ON` wirft der
`chat_messages`-Insert, und der Catch-Block (`chatService.ts:618`) ruft genau denselben
Insert erneut. Die Exception entkommt über das floating `void this.pump(...)` (`:216`), für
das es keinen Rejection-Handler gibt.

**Wie es geschlossen wird:** Ein Deckel `MAX_MESSAGE_CHARS` schließt die Zeile beim
Überschreiten ab und beginnt eine neue (der Stream bricht nicht ab), und ein
`services/deltaBuffer.ts` sammelt Deltas und schreibt höchstens alle ~100 ms bzw. ~4 KiB —
das behebt zugleich den quadratischen I/O. An der Parse-Grenze kommt eine Längengrenze pro
Event (1 MiB) dazu. Für F18 bekommt der floating `pump`-Aufruf ein `.catch`, und der
letzte Fehlerpfad wird nicht-werfend (eigener innerer `try/catch`, der nur noch loggt).

**Test-first**: 10 000 Deltas à 1 KiB → keine `chat_messages`-Zeile größer als der Deckel,
Gesamtinhalt vollständig, UPDATE-Zähler deutlich unter der Delta-Anzahl; ein Runner, dessen
Stream wirft, kombiniert mit einer DB, deren Insert im Fehlerpfad wirft → Test registriert
`process.on('unhandledRejection')` und erwartet **keinen** Aufruf, `sendMessage` resolved
trotzdem; `text-delta` mit 10 MiB → `null`.

---

## AP12 — Secrets und Doku (F15 + Doku-Divergenzen)

**F15 — Committetes Passwort für einen realen Live-Account.**
`apps/web/e2e-live/walkthrough.spec.ts:18` hardcodet `browsertest` / `test1234!` gegen die
**laufende** Instanz (`playwright.live.config.ts` zeigt auf `http://localhost:4000`), und
`CLAUDE.md:102` weist an, genau diesen approved Account anzulegen. Der Account existiert
tatsächlich (verifiziert) — das Passwort ist also gültig, nicht bloß ein Fixture.

**Wie es geschlossen wird:** Die Literale entfallen; ohne `MACVIBES_LIVE_USER` /
`MACVIBES_LIVE_PASSWORD` bricht der Spec mit klarer Meldung ab. `CLAUDE.md:102` wird
umformuliert. Ein kleiner Guard-Test liest die Spec-Datei und schlägt fehl, wenn wieder ein
Literal-Passwort darin steht. **Der Account selbst wird gelöscht** (AP0) — ein Commit
allein entwertet das Passwort nicht.

**Doku-Divergenzen im selben Commit** (aus dem Bericht):

- `README.md:66` und `REQUIREMENTS.md:52` versprechen einen **Invite-Code, den es nicht
  mehr gibt** — geschützt wird nur noch durch das Admin-Approval. Der Bericht hat den
  fehlenden Code ausdrücklich **nicht** als Lücke gewertet (Approval ist strenger), hält
  die Divergenz aber für fixwürdig, damit man sich nicht auf eine Kontrolle verlässt, die
  fehlt.
- Der Kommentar in `cookies.ts` behauptet „kein HTTPS in v1", während README und CLAUDE.md
  ein Caddy-TLS-Deployment dokumentieren (wird mit AP7 hinfällig).

---

## Reihenfolge und Abhängigkeiten

```
AP0  operativ (vorab, kein Code)
AP1  git-Absicherung          ──┐
AP2  fail-closed Backend      ──┤
AP3  Preview-Gateway          ──┼──► AP9  Pro-VM-Token
AP4  Egress-Policy            ──┘
AP5  Yoga/CORS/CSRF ──► AP6 Schema-Harness ──► AP7 Auth ──► AP8 Dateirechte
AP10 Lifecycle · AP11 chatService · AP12 Secrets   (unabhängig, jederzeit vorziehbar)
```

Ein Branch, **pro Arbeitspaket ein eigener Commit**, jeder einzeln `bun run ci`-grün und
mit deutscher Commit-Message. Empfohlene Reihenfolge: AP1 → AP2 → AP3 → AP4 → AP5 → AP6 →
AP7 → AP8 → AP9 → AP10 → AP11 → AP12.

## Migration und Regressionsrisiken

| Was                                | Auswirkung                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 11 Volumes mit `.git` im Workspace | `ensureWorkspace` migriert idempotent per `renameSync`; **vorher alle Sandboxes stoppen**, sonst läuft eine VM auf dem alten Mount   |
| `sessions`-Tabelle                 | wird geleert → alle 32 Sitzungen müssen sich neu anmelden                                                                            |
| Unique-Index auf `role='admin'`    | unkritisch (genau 1 Admin), Migration prüft und bricht sonst sauber ab                                                               |
| DB-Pfad                            | Alt-Pfad bleibt gültig, kein Zwangsumzug                                                                                             |
| Auto-Commit-Guard `index.ts:152`   | **höchstes Risiko**: wird er nicht mitgezogen, fällt der Auto-Commit still aus                                                       |
| LAN-Zugriff                        | CORS aus dem `Host`-Header ableiten, `secure` pro Request — sonst Login-Loop ohne Fehlermeldung                                      |
| Vite-Dev-Proxy                     | `changeOrigin: true` macht Dev-Requests cross-origin → Dev-Origin explizit erlauben                                                  |
| Playwright-E2E                     | AP2 (Env reicht), AP3 (Preview braucht Session), AP5 (Fehlertexte), AP6 (`MACVIBES_RATE_LIMIT_DISABLED=1` in `playwright.config.ts`) |
| VM-Neustart nach AP9               | Token-Wechsel invalidiert bestehende Daemon-Verbindungen                                                                             |

## Verifikation

1. `bun run ci` nach **jedem** Paket-Commit (lint + typecheck + alle Unit-/Integrationstests).
2. `bun --filter='@macvibes/web' run e2e` — vollständig grün, mit den in AP3/AP6 angepassten Specs.
3. Manuell nach AP1: ein echter Turn in einem Projekt, danach `git --git-dir=<volume>/git
log -1` prüfen und bestätigen, dass `<workspace>/.git` **nicht** existiert.
4. Manuell nach AP4: `bun add <paket>` in einer laufenden VM — muss weiterhin funktionieren.
5. Manuell nach AP3/AP7: Login und Preview **von einem zweiten LAN-Gerät** über
   `http://<mac-ip>:4000` und über Caddy-HTTPS — beides muss gehen.
6. Nach AP9: alle VMs neu starten, ein Turn pro Projekt.

## Nicht-Ziele und bewusstes Restrisiko

1. **Keine git-Tools für den Agenten** (vertagt) — der Host-Auto-Commit bleibt der einzige
   git-Pfad.
2. **Das Preview-Gateway bleibt eine geteilte Origin** (`host:4173`). Cookies und
   `localStorage` sind zwischen Previews nicht trennbar. Echter Fix wären Wildcard-Hostnamen
   pro Projekt plus Wildcard-TLS — eigenes Vorhaben. Das iframe-`sandbox` schließt nur die
   schlimmste Folge (Top-Navigation, Phishing).
3. **Fremde Sandboxes dürfen weiter gestartet werden** (`enterProject` ohne Ownership,
   bewusst so entschieden) — kein Rate-Limit darauf.
4. **Voller Public-Egress der VM bleibt** (bun/npm/Claude); der Agent kann Workspace-Inhalte
   exfiltrieren. Die Policy verhindert nur den Weg ins LAN und ins Loopback des Hosts.
5. **`bypassPermissions` in der VM bleibt** — das ist der Produktzweck.
6. **git-Submodule/Gitlinks** kann der Gast erzeugen; solange nie `submodule update` oder ein
   rekursiver Klon läuft, ist das folgenlos und wird nicht aktiv verhindert.
7. Kein Audit-Log, keine Session-Verwaltung im UI, kein 2FA.
