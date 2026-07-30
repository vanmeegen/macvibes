#!/usr/bin/env bash
# Preflight für `bun run dev`: verhindert Mehrfachstarts. Läuft schon eine
# macvibes-Instanz (belegte Ports), bricht der Start mit klarer Meldung ab —
# statt dass sich zwei Instanzen gegenseitig die Ports wegnehmen (EADDRINUSE,
# gegenseitige SIGTERMs, hängende Sandbox-Starts).
set -u

# Dieselben Env-Overrides wie Server und shutdown.sh.
WEB_PORT="${VITE_PORT:-5173}"
SERVER_PORT="${PORT:-4000}"
EGRESS_PORT="${MACVIBES_EGRESS_PORT:-4010}"

busy=""
for port in "$SERVER_PORT" "$EGRESS_PORT" "$WEB_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    busy="$busy :$port"
  fi
done

if [ -n "$busy" ]; then
  echo "✗ macvibes läuft offenbar schon — belegte Ports:$busy"
  echo "  Erst beenden:  bun run shutdown"
  echo "  Dann erneut:   bun run dev"
  exit 1
fi

# Erst-Admin (H3): Ohne MACVIBES_ADMIN_USERNAME vergibt die Registrierung keine
# Admin-Rolle mehr — vorher wurde der erste Registrant Admin, was bei einem im
# LAN lauschenden Server ein Wettlauf um Admin-Rechte war. Auf einer FRISCHEN
# Installation heißt das aber: man registriert sich und kann danach niemanden
# freischalten, auch sich selbst nicht. Das hier fängt es vor dem Start ab.
# Existiert die Datenbank schon, bleibt die Prüfung still — dann weiß der Server
# beim Start selbst, ob ein Admin da ist (ensureAdmin warnt sonst).
ENV_FILE="apps/server/.env"
admin_name="${MACVIBES_ADMIN_USERNAME:-}"
if [ -z "$admin_name" ] && [ -f "$ENV_FILE" ]; then
  # Erster nicht auskommentierter Eintrag; Anführungszeichen und Leerraum weg.
  admin_name="$(sed -n 's/^[[:space:]]*MACVIBES_ADMIN_USERNAME[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" |
    tail -1 | sed 's/^["'"'"']//; s/["'"'"']$//; s/[[:space:]]*$//')"
fi

# DB-Pfad wie resolveDbPath() in apps/server/src/config.ts. ACHTUNG: dessen
# Legacy-Zweig `./data/<name>` ist relativ zum Arbeitsverzeichnis des SERVERS
# (apps/server), dieses Skript läuft aber im Repo-Root — beide Varianten prüfen,
# sonst gilt eine bestehende Installation fälschlich als frisch.
db_found=""
for candidate in \
  "${DB_PATH:-}" \
  "apps/server/data/app.db" \
  "./data/app.db" \
  "${MACVIBES_HOME:-$HOME/macvibes}/data/app.db"; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then
    db_found="$candidate"
    break
  fi
done

if [ -z "$admin_name" ] && [ -z "$db_found" ]; then
  echo "✗ Frische Installation ohne MACVIBES_ADMIN_USERNAME"
  echo "  Keine Datenbank gefunden — und kein Bootstrap-Admin benannt."
  echo "  Ohne ihn wird niemand Admin, und ohne Admin schaltet niemand Nutzer frei."
  echo
  echo "  In apps/server/.env eintragen:  MACVIBES_ADMIN_USERNAME=<dein-username>"
  echo "  Dann erneut:                    bun run dev"
  exit 1
fi
