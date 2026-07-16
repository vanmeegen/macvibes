---
status: accepted
---

# node_modules: Boot-Delta-Install aus bun.lock statt overlayfs

Projekt-VMs forken bei jedem Start den Baseline-Snapshot; `node_modules` im
Workspace ist ein Symlink auf die VM-lokale Fork-Platte (`/baseline/work`).
Ein `bun add` des Agenten schrieb durch den Symlink auf die ephemere Platte
und war nach dem nächsten VM-Start verloren — während `package.json`/`bun.lock`
(Volume + Auto-Commit) überlebten: Dependency deklariert, aber nicht
installiert, Preview kaputt (Live-Befund 2026-07-16).

**Entscheidung:** `bun.lock` ist die Source of Truth, `node_modules` bleibt
reproduzierbarer Ableitungszustand auf der schnellen VM-lokalen Platte.
`devserver-run.sh` führt vor dem `devCommand` ein `bun install` aus, das nur
das Delta rekonstruiert — gespeist aus einem persistenten Bun-Cache auf dem
Projekt-Volume (`BUN_INSTALL_CACHE_DIR=/bun-cache`, gilt auch für `bun add`
des Agenten). Der Cache hält nur Delta-Pakete, keinen Spiegel der Basis.
Heilt Bestandsprojekte automatisch (deren `bun.lock` die verlorenen Pakete
schon deklariert) und den Baseline-Rebuild-Fall — keine Migration nötig.

## Spike-Messwerte (2026-07-16, echte Projekt-VM)

- `bun install` im No-Delta-Fall: **17 ms** — Boot-Kosten vernachlässigbar.
- `bun add` über den Egress-Proxy (`daemon.env.sh`-Env): funktioniert, 401 ms
  für ein Kleinstpaket. Public-Egress ohne Proxy ist durch den msb-Bug tot,
  deshalb sourcet der Install die Daemon-Env — in einer Subshell, damit das
  Proxy-Token nicht an den devCommand (User-Code) leakt.
- Bun-Cache auf virtiofs-Mount: Schreiben und Wiederverwendung funktionieren.

## Verworfene Alternativen

- **overlayfs (lower = Snapshot, upper = Volume):** (1) upperdir auf virtiofs
  braucht xattr/Whiteout-Support, den libkrun/virtio-fs nicht zusichert;
  (2) der Killer ist der **Stale Upper**: nach `bun run baselines` mischt ein
  alter Upper mit dem neuen Lower stillschweigend inkonsistente Paketstände —
  die einzige saubere Reconciliation wäre `bun install` gegen `bun.lock`,
  also genau der gewählte Mechanismus; Overlay wäre nur zusätzliche
  Komplexität obendrauf.
- **node_modules real aufs Volume kopieren:** Erstboot-Kopie über virtiofs
  dauert zig Sekunden bis Minuten (verletzt die Sekunden-Anforderung an die
  erste Preview) und der Dev-Server läse danach dauerhaft über virtiofs —
  genau der Grund, warum das Symlink-Design existiert.
- **Hybrid (Symlink + Hintergrund-Kopie + Switch):** erbt ab dem zweiten Boot
  den virtiofs-Lese-Malus des Voll-Kopie-Ansatzes.

## Konsequenzen

- Cache pro Projekt (kein globaler Cache): nie zwei VMs, die gleichzeitig in
  dasselbe virtiofs-Verzeichnis schreiben. Globaler Cache = mögliche spätere
  Optimierung.
- Install-Fehler sind nicht fatal (`|| echo … >&2`): der Dev-Server startet
  trotzdem; fehlt das Delta wirklich (offline ohne Cache), endet der
  devCommand im monit-Crash-Loop → `previewStatus: failed` mit Log in
  `/var/log/macvibes-devserver.log` — ehrlicher Zustand statt stiller
  Kaputtheit.
- Sammeln sich viele Deltas an, ist `bun run baselines` die Antwort: die
  Pakete wandern in den Snapshot, der Cache wird wieder irrelevant.
