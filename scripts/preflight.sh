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
