#!/usr/bin/env bash
# Beendet alles, was `bun run dev` startet: Web (Vite), Server, Egress-Proxy
# und alle laufenden macvibes-MicroVMs. Idempotent — mehrfaches Ausführen ist ok.
set -u

# Ports respektieren die Env-Overrides (mit denselben Defaults wie der Server).
WEB_PORT="${VITE_PORT:-5173}"
SERVER_PORT="${PORT:-4000}"
EGRESS_PORT="${MACVIBES_EGRESS_PORT:-4010}"

# ZUERST den `bun run dev`-Elternprozess beenden — sonst startet er die eben
# gekillten Kinder (Web/Server) sofort neu (Race).
pkill -f "run --filter.* dev" 2>/dev/null || true
pkill -f "apps/server/src/index.ts" 2>/dev/null || true

echo "→ Beende Dev-Ports ($WEB_PORT Web, $SERVER_PORT Server, $EGRESS_PORT Egress) …"
kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  echo "$pids" | xargs kill 2>/dev/null || true
  # kurzer Nachschlag: was nach 1s noch lauscht, hart beenden.
  sleep 1
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
  echo "  :$port beendet"
}
for port in "$WEB_PORT" "$SERVER_PORT" "$EGRESS_PORT"; do
  kill_port "$port"
done

echo "→ Stoppe laufende macvibes-MicroVMs …"
if command -v msb >/dev/null 2>&1; then
  vms=$(msb list 2>/dev/null | awk 'NR>1 && $1 ~ /^macvibes-/ {print $1}')
  if [ -n "$vms" ]; then
    echo "$vms" | while IFS= read -r vm; do
      msb stop "$vm" >/dev/null 2>&1 && echo "  $vm gestoppt"
    done
  else
    echo "  keine laufenden VMs"
  fi
else
  echo "  (msb nicht installiert — übersprungen)"
fi

echo "✓ macvibes heruntergefahren."
