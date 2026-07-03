# macvibes — Requirements (PRD)

Lokale Vibe-Coding-Plattform für den Mac: Projekte werden in isolierten
microsandbox-MicroVMs entwickelt — mit Chat-Interface zu Claude Code und
Live-Preview der entstehenden App, ähnlich Lovable, aber komplett lokal.

Status: gegrillt & abgestimmt, Stand 2026-07-03

---

## 1. Ziel & Vision

Marco legt in einer schlanken Web-UI ein **Projekt** an (aus einem Template),
klickt es an und landet auf der **Chat-Page**: links der Chat mit dem Coding-
Agenten (Claude Code in einer Sandbox), rechts die **Live-Preview** der App,
die gerade gebaut wird. Jeder Agent-Turn wird automatisch committet und
gepusht. Verlässt er das Projekt, läuft die Sandbox noch 15 Minuten weiter
und wird dann gestoppt; beim nächsten Öffnen startet sie automatisch neu.

Alles läuft lokal auf dem Mac, alles TypeScript auf Bun, keine externen
Dienste außer der Claude API.

## 2. Begriffe

| Begriff       | Bedeutung                                                                 |
| ------------- | ------------------------------------------------------------------------- |
| **Projekt**   | Zentrale Einheit (kein „Session"-Begriff im UI). Hat Namen, Template, Branch, Historie. |
| **Sandbox**   | microsandbox-MicroVM, in der Claude Code und der Preview-Server eines Projekts laufen. |
| **Chat-Page** | Seite eines Projekts: Chat-Interface + Live-Preview nebeneinander.        |
| **Template**  | Vorlagen-Projekt unter `templates/`, Ausgangspunkt für neue Projekte.     |
| **macvibes-apps** | Das eine Git-Repo, in dem alle Projekte leben — **ein Orphan-Branch pro Projekt**. |
| **Agent-Runner** | Kleiner Bun-Prozess in der VM: treibt Claude Code über das Agent SDK und streamt Events zum Server. |
| **User / Owner** | Lokales Benutzerkonto (Username + Passwort). Jedes Projekt gehört genau einem Owner. |

## 3. Architektur-Entscheidungen (gegrillt am 2026-07-03)

| Thema             | Entscheidung                                                                 |
| ----------------- | ---------------------------------------------------------------------------- |
| Stack             | Wie `behandlungsverwaltung`: Bun-Monorepo (`apps/web`, `apps/server`, `packages/shared`), TS strict, `Bun.serve` + GraphQL Yoga + Pothos, `bun:sqlite` + Drizzle, React 18 + MobX + MUI + Vite, ESLint 9 + Prettier + Husky. |
| Sandbox           | microsandbox (MicroVMs via libkrun, macOS Apple Silicon). Vorgebackenes Basis-Image mit Bun, git, Claude Code + Agent-Runner für schnellen Boot. |
| Agent-Anbindung   | **Agent-SDK-Runner** in der VM: strukturierte Events (Text, Tool-Use, Turn-Ende) per WebSocket zum Server; Browser erhält sie via GraphQL Subscriptions (SSE) — GraphQL-only bleibt gewahrt. |
| Autonomie         | Claude Code läuft mit **bypassPermissions** (volle Autonomie); die Isolation leistet die MicroVM. |
| Credentials       | **Proxy über Host**: die VM erhält keine Claude-Credentials. `ANTHROPIC_BASE_URL` zeigt auf den macvibes-Server, der die Auth-Header injiziert. |
| Git-Modell        | Lokales **Bare-Repo** `macvibes-apps.git` auf dem Host als primärer Remote (in die VM gemountet). **Ein Orphan-Branch pro Projekt**, erster Commit = Template-Inhalt. |
| GitHub            | Asynchroner Mirror-Push nach GitHub per Cron/Scheduler im Server; das GitHub-Token bleibt auf dem Host und erreicht nie die VM. |
| Persistenz        | **Volume pro Projekt** (Workspace, `~/.claude`-Sessiondaten, `node_modules`), bei jedem VM-Start gemountet → Claude-Session überlebt VM-Stopps (`--resume`). Kein Verlass auf VM-Snapshots. |
| Preview-Routing   | **Port pro Sandbox**: Preview-Port der VM wird auf einen freien Host-Port gemappt, das iframe zeigt direkt darauf (HMR-WebSocket funktioniert nativ). |
| Preview-Start     | `templates.json` liefert pro Template `devCommand` und `previewPort`; wird beim Anlegen ins Projekt übernommen. |
| Ressourcen        | Max **8 parallele Sandboxes**, je **4 GB RAM / 2 vCPUs**, konfigurierbar. Beim Überschreiten wird die am längsten inaktive Sandbox vorzeitig gestoppt (LRU). (Host: M5 Pro, 18 Kerne, 48 GB.) |
| PWA-Libraries     | Excel: **SheetJS (`xlsx`)**; Charts: **Recharts**. |
| Auth              | Lokale Accounts: Username + Passwort, Hash via `Bun.password` (argon2id) in SQLite, httpOnly-Session-Cookie (**3 Tage, rollierend**). Registrierung auf der Login-Seite, geschützt durch **Invite-Code** aus der Server-Config. Keine externen Identity-Dienste. |
| Rechte            | Fremde Projekte: **lesend** (Liste, Historie, Preview). Anlegen, Löschen und Chat nur für den Owner. |
| Zugriff           | **LAN**: Server bindet `0.0.0.0` und liefert das gebaute Web-UI selbst aus (`http://<mac>.local:4000`); Preview-iframes verwenden den Hostnamen des Aufrufers. |

## 4. Funktionale Anforderungen

### R1 — Projekt anlegen

Der Nutzer legt über einen Plus-Button ein neues Projekt an: Name eingeben,
Template auswählen, fertig.

**Akzeptanzkriterien**

- [ ] Auf der Projektübersicht gibt es einen Plus-Button „Neues Projekt".
- [ ] Der Dialog verlangt einen Projektnamen und die Auswahl genau eines Templates.
- [ ] Aus dem Projektnamen wird automatisch ein gültiger Git-Branch-Name
      abgeleitet (z. B. „Mein Dashboard!" → `mein-dashboard`); Kollisionen
      werden durch Suffix aufgelöst (`mein-dashboard-2`).
- [ ] Beim Anlegen wird in `macvibes-apps` ein neuer **Orphan-Branch** erzeugt;
      der erste Commit enthält den Inhalt des gewählten Templates im Repo-Root.
- [ ] Das Projekt erscheint sofort in der Projektübersicht (Name, Template,
      Erstellungsdatum, Status).
- [ ] Das Projekt gehört dem angemeldeten User (Owner); Anlegen ist nur
      angemeldet möglich.
- [ ] Ungültige Eingaben (leerer Name, doppelter Name) zeigen eine
      verständliche Fehlermeldung; es entsteht kein halb-angelegtes Projekt
      (kein Branch, kein DB-Eintrag, kein Volume).

### R2 — Projektübersicht & Öffnen

**Akzeptanzkriterien**

- [ ] Die Startseite listet Projekte aus der SQLite-DB mit Name, **Owner**,
      Template, letzter Aktivität und Sandbox-Status (läuft / stoppt in X min / gestoppt).
- [ ] Ein Umschalter filtert die Liste: **„Alle" / „Nur meine"**; Standard ist
      „Nur meine", die Wahl wird pro Browser gemerkt.
- [ ] Klick auf ein Projekt öffnet dessen Chat-Page (fremde Projekte: lesend, siehe R10).
- [ ] Ein eigenes Projekt kann gelöscht werden (mit Bestätigungsdialog); dabei
      werden Sandbox gestoppt und Volume entfernt. Der Git-Branch bleibt
      erhalten (kein Datenverlust am Code). Bei fremden Projekten wird kein
      Löschen angeboten; serverseitig wird es verweigert.

### R3 — Templates

Templates liegen als Unterordner in `templates/` und werden dynamisch
gelesen und zur Auswahl angeboten.

**Akzeptanzkriterien**

- [ ] `templates/templates.json` enthält pro Template einen Eintrag mit
      `name`, `description`, `dir` (Name des Unterordners), `devCommand`
      (z. B. `bun run dev`) und `previewPort` (z. B. `5173`).
- [ ] Der Anlege-Dialog liest `templates.json` bei jedem Öffnen dynamisch —
      ein neu hinzugefügtes Template erscheint ohne Neustart der Plattform.
- [ ] Templates mit Eintrag in `templates.json`, aber fehlendem Ordner
      (oder umgekehrt) werden nicht angeboten und serverseitig als Warnung geloggt.
- [ ] `devCommand`/`previewPort` werden beim Anlegen in die Projekt-Metadaten
      (SQLite) übernommen; spätere Änderungen an `templates.json` wirken nur
      auf neue Projekte.

### R4 — Template „pwa": Client-only React-PWA

Sehr schlankes Template für Webanwendungen **ohne Server** — interaktive
Apps, die rein im Browser laufen. Wichtigstes Template.

**Akzeptanzkriterien**

- [ ] Stack: React + MobX + Vite + TypeScript strict, als simple PWA
      (Manifest + Service Worker), kein Backend.
- [ ] **Excel-Upload integriert** via SheetJS (`xlsx`): Drag & Drop einer
      Excel-Datei in die laufende App, Sheets/Zeilen werden als typisierte
      Daten gelesen.
- [ ] **Recharts integriert:** Dashboards/Charts können direkt aus den
      hochgeladenen Daten gerendert werden.
- [ ] Das Template startet out-of-the-box: `bun install && bun run dev`
      zeigt eine Demo-Seite mit funktionierendem Excel-Drop und einem Beispiel-Chart.
- [ ] Liegt unter `templates/pwa/` mit Eintrag in `templates.json`.

### R5 — Template „fullstack"

**Akzeptanzkriterien**

- [ ] Full-Stack-Vorlage mit demselben Stack wie macvibes selbst:
      Bun-Monorepo, `Bun.serve` + GraphQL Yoga + Pothos, Drizzle +
      `bun:sqlite`, React + MobX + Vite Frontend.
- [ ] Startet out-of-the-box mit einer minimalen Beispiel-Query von UI bis DB
      über einen einzigen `devCommand` (Vite proxied den Server, Preview über
      einen Port).
- [ ] Liegt unter `templates/fullstack/` mit Eintrag in `templates.json`.

### R6 — Chat-Page & Chat-Interface

**Akzeptanzkriterien**

- [ ] Die Chat-Page zeigt Chat (Eingabe + Verlauf) und Live-Preview
      gleichzeitig nebeneinander.
- [ ] Beim Öffnen der Chat-Page wird die Sandbox des Projekts automatisch
      gestartet, falls sie nicht läuft; der Startfortschritt ist sichtbar
      (z. B. „Sandbox startet…").
- [ ] Nutzereingaben gehen an den Agent-Runner (Claude Agent SDK) in der
      Sandbox; Agent-Events (Text, Tool-Use, Turn-Ende) werden **live
      gestreamt** angezeigt (nicht erst am Turn-Ende), transportiert per
      GraphQL Subscription.
- [ ] Claude Code arbeitet mit voller Autonomie (bypassPermissions) — es
      erscheinen keine Permission-Rückfragen im Chat.
- [ ] Chat-Eingaben sind nur für den Owner möglich; andere User sehen die
      Chat-Page read-only (Verlauf + Preview, Eingabefeld ersetzt durch
      Hinweis). Die Sperre wird serverseitig durchgesetzt, nicht nur im UI.
- [ ] Die Chat-Historie eines Projekts wird in SQLite persistiert und beim
      erneuten Öffnen vollständig wieder angezeigt.
- [ ] Der Agent arbeitet im Projekt-Workspace (Checkout des Projekt-Branches
      auf dem Projekt-Volume) innerhalb der Sandbox; er hat keinen Zugriff
      auf das Host-Dateisystem und keine Claude-Credentials (API läuft über
      den Host-Proxy).

### R7 — Live-Preview

Wie bei Lovable: man sieht immer live, welche App gerade gebaut wird.

**Akzeptanzkriterien**

- [ ] In jeder Sandbox läuft zusätzlich zum Agenten der Preview-Server des
      Projekts, gestartet über das `devCommand` aus den Projekt-Metadaten.
- [ ] Der `previewPort` der VM wird beim Start auf einen freien Host-Port
      gemappt; das iframe der Chat-Page zeigt direkt auf diesen Port und
      verwendet dabei den Hostnamen, über den die Plattform aufgerufen wurde
      (LAN-tauglich, kein hartes `localhost`).
- [ ] Ändert der Agent Code, aktualisiert sich die Preview automatisch
      (HMR bzw. Auto-Reload) — ohne manuelles Eingreifen; der HMR-WebSocket
      funktioniert über das Port-Mapping.
- [ ] Ist die App (noch) nicht lauffähig, zeigt die Preview einen klaren
      Zustand (z. B. Build-Fehler / „Preview nicht verfügbar") statt einer
      leeren Fläche.

### R8 — Auto-Commit & Push

Jeder Agent-Turn wird automatisch gesichert.

**Akzeptanzkriterien**

- [ ] Nach jedem abgeschlossenen Agent-Turn (Turn-Ende-Event des SDK) wird im
      Projekt-Branch automatisch ein Commit erzeugt und ins lokale Bare-Repo
      `macvibes-apps.git` gepusht.
- [ ] Die Commit-Message referenziert den Turn nachvollziehbar
      (z. B. Kurzfassung der Nutzeranweisung).
- [ ] Turns ohne Dateiänderungen erzeugen keinen leeren Commit.
- [ ] Schlägt Commit/Push fehl, wird das im Chat sichtbar gemeldet —
      niemals stillschweigend verschluckt.
- [ ] Ein Scheduler im macvibes-Server spiegelt das Bare-Repo periodisch
      nach GitHub (`git push --mirror` o. ä.); das GitHub-Token liegt
      ausschließlich auf dem Host. Mirror-Fehler werden geloggt und in der
      UI angezeigt, blockieren aber das lokale Arbeiten nicht.

### R9 — Sandbox-Lebenszyklus

**Akzeptanzkriterien**

- [ ] Verlässt der Nutzer die Chat-Page/das Projekt, bleibt die Sandbox
      **15 Minuten** aktiv (Grace-Period).
- [ ] Nach 15 Minuten ohne erneutes Öffnen wird die MicroVM automatisch
      gestoppt; zuvor wird ein eventuell offener Stand committet/gepusht.
- [ ] Auch bei geöffneter Chat-Page: nach **30 Minuten ohne Agent-Aktivität**
      (kein laufender/neuer Turn) wird die VM gestoppt (vorher Auto-Commit);
      die Chat-Page zeigt „Sandbox pausiert" mit Ein-Klick-Neustart.
- [ ] Erneutes Öffnen des Projekts startet die Sandbox automatisch neu:
      Projekt-Volume wird gemountet, Agent-Runner setzt die Claude-Session
      fort (`--resume` auf Basis der persistierten Sessiondaten), Preview-
      Server läuft wieder, die Chat-Historie ist vorhanden.
- [ ] Rückkehr innerhalb der Grace-Period verbindet sich mit der laufenden
      Sandbox (kein Neustart, kein Kontextverlust).
- [ ] Es laufen maximal 8 Sandboxes gleichzeitig (konfigurierbar); beim
      Überschreiten wird die am längsten inaktive Sandbox vorzeitig
      gestoppt (nach Auto-Commit).
- [ ] Der Sandbox-Status (läuft / stoppt in X min / gestoppt) ist in der
      Projektübersicht sichtbar.

### R10 — Login & Benutzer

Einfacher lokaler Login; Projekte sind Usern zugeordnet.

**Akzeptanzkriterien**

- [ ] Ohne gültige Session wird jede Seite auf die Login-Seite umgeleitet.
- [ ] Die Login-Seite bietet Anmelden **und** Registrieren (Username + Passwort);
      ein neuer Username wird sofort registriert und angemeldet.
- [ ] Registrieren erfordert zusätzlich den **Invite-Code** aus der
      Server-Config; falscher Code → Fehlermeldung, kein Account.
- [ ] Die Session gilt **3 Tage** und verlängert sich bei jeder Nutzung
      (rollierend).
- [ ] Passwörter werden ausschließlich als Hash gespeichert
      (`Bun.password`, argon2id); nie im Klartext geloggt oder übertragen
      außer im Login-Request selbst.
- [ ] Die Session läuft über ein httpOnly-Cookie; Logout invalidiert die
      Session serverseitig.
- [ ] Doppelte Usernames und falsche Passwörter erzeugen verständliche
      Fehlermeldungen ohne preiszugeben, ob der Username existiert.
- [ ] Jedes Projekt hat genau einen Owner; alle GraphQL-Mutationen, die ein
      Projekt verändern (löschen, Chat-Eingabe, später Lifecycle-Aktionen),
      prüfen serverseitig die Ownership.
- [ ] Fremde Projekte sind lesend zugänglich: Projektliste, Chat-Verlauf und
      Preview dürfen betrachtet werden.

## 5. Nicht-funktionale Anforderungen

- **Lokal:** Plattform, Sandboxes, Git-Repo und DB laufen vollständig auf
  Marcos Mac; einzige externe Abhängigkeiten sind die Claude API
  (über Host-Proxy) und der optionale GitHub-Mirror. Andere User greifen
  über das LAN zu (`http://<mac>.local:4000`), der Server liefert das
  gebaute Web-UI aus.
- **Leichtgewichtig:** wenige Abhängigkeiten, Bun-native Lösungen bevorzugt;
  kein Kubernetes, kein externer DB-Server.
- **Isolation:** Agent-Code läuft ausschließlich in der MicroVM; kein
  Host-Dateisystemzugriff, keine Credentials in der VM.
- **Ressourcen:** 4 GB RAM / 2 vCPUs pro Sandbox, max 8 parallel
  (Host: M5 Pro, 18 Kerne, 48 GB) — alle Werte konfigurierbar.
- **Schneller Einstieg:** Öffnen eines bestehenden Projekts bis zur
  interaktionsbereiten Chat-Page in wenigen Sekunden (vorgebackenes
  Basis-Image + persistentes Volume, kein erneutes `bun install`).
- **Mehrbenutzer, lokal:** mehrere lokale Benutzerkonten (Username + Passwort),
  keine externen Identity-Dienste. Kein Anspruch auf Härtung gegen böswillige
  Nutzer im selben Netz (kein HTTPS in v1).
- **Konventionen:** wie `behandlungsverwaltung` — Presentation-Model-Pattern,
  GraphQL-only, strikte Typen, keine verschluckten Exceptions, TDD,
  `bun run ci` vor jedem Commit.

## 6. Offene Punkte

- [ ] GitHub-Mirror: Ziel-Repo und Push-Intervall festlegen (Default-Vorschlag:
      alle 10 Minuten, nur bei neuen Commits).
- [ ] Basis-Image: exakter Inhalt und Build-Prozess (Bun-Version, Claude-Code-
      Version, Update-Strategie).
- [ ] Verhalten bei Claude-API-Ausfall/Rate-Limit im Chat (Anzeige, Retry).

## 7. Out of Scope (v1)

- Deployment/Hosting der gebauten Apps.
- Passwort-Reset, Profilverwaltung, Rollen/Admin, Ownership-Übertragung, HTTPS.
- Diff-/Review-UI (Git-Historie reicht in v1).
- Andere Agents als Claude Code; andere Sandbox-Backends als microsandbox.
- Mobile UI der Plattform selbst.
- Permission-Rückfragen im Chat (v1 = volle Autonomie).
