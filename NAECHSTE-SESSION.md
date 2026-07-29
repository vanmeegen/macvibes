# Starter-Prompt für die nächste Session

Alles unten ist Kontext für eine **frische** Claude-Code-Session. Grund für den
Wechsel: Das Subagenten-Kontingent der alten Session ist aufgebraucht (200/200),
deshalb lässt sich dort kein Security-Scan mehr starten.

---

## Prompt zum Kopieren

> Ich arbeite an macvibes (`~/projects/macvibes`), aktuell auf dem Branch
> `security/haertung-26-findings` mit 23 Commits. Der Branch behebt die Findings
> zweier Security-Scans. Nichts davon ist gepusht — **bitte niemals ohne meine
> ausdrückliche Zusage pushen**, das Repo ist öffentlich und die Commit-Messages
> beschreiben Schwachstellen im Detail.
>
> Bitte starte einen vollständigen Security-Scan des Repos mit `/claude-security`
> („Scan codebase", ganzes Repository, gründlich). Wichtig: Der letzte Lauf musste
> als `unverified` abschließen, weil das Subagenten-Budget mitten im Dispatch
> aufgebraucht war und **das komplette Verifikations-Panel abgewiesen wurde**.
> Plane das Budget diesmal so, dass die Verifikation garantiert stattfindet —
> lieber weniger Forscher und dafür jeden Befund durchs Panel.
>
> Details, offene Kandidaten und Bedrohungsmodell stehen in
> `NAECHSTE-SESSION.md` im Repo-Root. Lies die Datei zuerst.

---

## Was bisher geschah

Drei Etappen, alle auf dem genannten Branch, jede mit `bun run ci` grün
(zuletzt 420 Server-Tests) und Playwright-E2E 33/33.

1. **Scan 1** (`CLAUDE-SECURITY-20260725-095652`, Commit `a9221e7`): 26 Findings,
   9 HIGH. **Alle behoben** — u. a. ein vollständiger Ausbruch aus der MicroVM
   über gast-geschriebene git-Hooks, ein unauthentifiziertes Preview-Gateway,
   ein offener SSRF-Tunnel im Egress-Proxy, ein Shared Secret für drei Rollen.
2. **Live-Durchtest** mit echten MicroVMs und echtem Claude: dabei kam ein
   Hänger zutage, den kein Scan gefunden hatte (stiller Config-Warmup ohne Frist
   blockierte die Turn-Queue unbegrenzt). Behoben.
3. **Scan 2** (`CLAUDE-SECURITY-20260728-211158`): 22 Findings, davon 13 **durch
   die Härtung selbst entstanden**. Behoben: F1 (HIGH), F2, F8, F9, F14, F16,
   F21, F22. ⚠️ **Dieser Bericht ist `unverified`** — kein Befund wurde von einem
   unabhängigen Prüfer angegriffen. Zum Vergleich: In Scan 1 kippte das Panel
   23 von 49 Kandidaten.

## Noch offen (aus Scan 2, ohne Panel-Urteil)

Bitte gezielt prüfen, ob sie real sind:

| ID      | Kurz                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| F4      | Preview-Gateway authentifiziert, autorisiert aber nicht (bewusste Entscheidung, R10 — Tragweite ungeklärt) |
| F5      | Unauthentifizierte Registrierung samt Admin-Bootstrap                                                      |
| F10     | Sandbox kann per `Set-Cookie` ein Cookie für den ganzen Host setzen                                        |
| F15     | Egress-Proxy verwaist Upstream-Sockets bei Client-Abbruch                                                  |
| F17/F18 | Hostpfade bzw. angreiferkontrollierte Ziele landen in Logs                                                 |
| F19     | `SAFE_GIT_ENV` nur in `runGitInRepo`, nicht an den Schwester-Aufrufstellen                                 |
| F20     | Username-Enumeration über Login-Timing                                                                     |

## Bedrohungsmodell

Der Agent in der MicroVM ist **per Design nicht vertrauenswürdig** (Claude Code
mit `bypassPermissions`, Netzzugang, installiert Pakete) — die VM-Grenze ist die
Sicherheitsgrenze. Der Server bindet `0.0.0.0` und ist im LAN erreichbar;
angemeldete Nutzer sind teils vertrauenswürdig, aber nicht privilegiert. Fremde
Projekte sind **bewusst** lesend zugänglich, fremde Sandboxes dürfen **bewusst**
gestartet werden (R10).

## Bewusst offenes Restrisiko (nicht als Finding melden)

- Alle Previews teilen sich eine Origin auf Port 4173 — echte Trennung bräuchte
  Wildcard-Hostnamen plus TLS, eigenes Vorhaben.
- Die VM darf ungefiltert ins öffentliche Netz (bun/npm/Claude); die
  Egress-Policy sperrt nur LAN und Loopback des Hosts.
- Der Warmup-Abbruch wirkt host-seitig; der Daemon in der VM bleibt bei totem
  Upstream belegt und weist den nächsten Turn sichtbar ab.
- `bypassPermissions` in der VM bleibt — das ist der Produktzweck.

## Danach

1. Befunde des dritten Scans abarbeiten.
2. Push- bzw. Merge-Entscheidung nach `main` — **erst nach meiner Zusage**,
   ggf. Repo vorher auf privat stellen.
3. Optional: die letzten ~800 ms Preview-Latenz. Gemessen liegen sie IN der VM
   (`previewStatusReporter.ts:65` fragt monit alle 2000 ms, monit selbst läuft
   mit `set daemon 2`). Sauber wäre derselbe Trick wie host-seitig: eng takten
   bis zum ersten `ready`, danach zurück auf 2000 ms.
