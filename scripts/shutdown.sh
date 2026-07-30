#!/usr/bin/env bash
# Beendet alles, was `bun run dev` startet: Web (Vite), Server, Egress-Proxy
# und alle laufenden macvibes-MicroVMs. Idempotent — mehrfaches Ausführen ist ok.
set -u

# Ohne lsof findet dieses Skript keinen einzigen Prozess — und weil jeder
# lsof-Aufruf mit `|| true` abgesichert ist, sähe das Ergebnis wie ein
# erfolgreiches Herunterfahren aus, obwohl nichts beendet wurde. Lieber hier
# hart abbrechen als still nichts tun. (Auf macOS liegt lsof in /usr/sbin —
# ein verkürztes PATH reicht nicht.)
if ! command -v lsof >/dev/null 2>&1; then
  echo "✗ lsof nicht gefunden — dieses Skript kann ohne lsof nichts beenden."
  echo "  Auf macOS liegt es in /usr/sbin; PATH prüfen."
  exit 1
fi

# Ports respektieren die Env-Overrides (mit denselben Defaults wie der Server).
WEB_PORT="${VITE_PORT:-5173}"
SERVER_PORT="${PORT:-4000}"
EGRESS_PORT="${MACVIBES_EGRESS_PORT:-4010}"
# Das Preview-Gateway hält einen eigenen festen Port. Heute ist es derselbe
# Prozess wie der Server, es fiele also mit ihm — aber das ist eine Annahme über
# die Prozessstruktur, nicht über den Vertrag. Explizit aufführen.
GATEWAY_PORT="${MACVIBES_PREVIEW_GATEWAY_PORT:-4173}"

# ZUERST den `bun run dev`-Elternprozess beenden — sonst startet er die eben
# gekillten Kinder (Web/Server) sofort neu (Race). Nur DIESER Elternprozess
# startet Kinder neu; `bun run start` (Produktion) tut das nicht, deshalb genügt
# dort das Beenden über die Ports weiter unten.
pkill -f "run --filter.* dev" 2>/dev/null || true

# Wie lange der Server für seinen geordneten Abgang bekommt. Er stoppt bei
# SIGTERM ERST alle Sandboxes samt Auto-Commit (index.ts: shutdown → stopAll →
# onBeforeStop, R9) und beendet sich dann — das dauert pro VM Sekunden. Vorher
# stand hier ein fester `sleep 1` mit anschließendem kill -9: der riss den
# Server mitten aus dem Stoppen heraus, die überlebenden VMs fielen dem
# msb-Sweep unten zu, und DER löst keinen Auto-Commit aus. Mit laufenden VMs
# ging so bei jedem Shutdown der letzte Commit verloren.
GRACE_SECONDS="${MACVIBES_SHUTDOWN_GRACE:-45}"

echo "→ Beende Ports ($WEB_PORT Web, $SERVER_PORT Server, $EGRESS_PORT Egress, $GATEWAY_PORT Gateway) …"
kill_port() {
  local port="$1"
  local pids waited
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  echo "$pids" | xargs kill 2>/dev/null || true

  # Auf den geordneten Abgang warten, statt ihn abzuschneiden.
  waited=0
  while [ "$waited" -lt "$GRACE_SECONDS" ]; do
    if ! lsof -ti:"$port" >/dev/null 2>&1; then
      echo "  :$port beendet (nach ${waited}s)"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "  :$port reagiert nach ${GRACE_SECONDS}s nicht — hart beenden (kill -9)"
  echo "     Achtung: ein noch laufender Auto-Commit wird dadurch abgebrochen."
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
}
for port in "$WEB_PORT" "$SERVER_PORT" "$EGRESS_PORT" "$GATEWAY_PORT"; do
  kill_port "$port"
done

# Sicherheitsnetz für verwaiste VMs. Im Normalfall ist hier nichts mehr zu tun:
# der Server hat seine Sandboxes beim SIGTERM oben selbst gestoppt, MIT
# Auto-Commit. Findet dieser Sweep noch etwas, ist genau das misslungen — er
# stoppt dann hart und ohne Commit. Deshalb wird es hier deutlich gemeldet,
# statt als Erfolg durchzulaufen.
#
# ACHTUNG: Dieser Teil ist NICHT auf die Ports oben eingegrenzt — er stoppt jede
# macvibes-VM auf dem Host. Das Skript ist damit nicht gegen eine Instanz auf
# Ersatzports testbar, ohne echte VMs mitzunehmen.
echo "→ Prüfe auf verwaiste macvibes-MicroVMs …"
if command -v msb >/dev/null 2>&1; then
  vms=$(msb list 2>/dev/null | awk 'NR>1 && $1 ~ /^macvibes-/ && $3 == "running" {print $1}')
  if [ -n "$vms" ]; then
    echo "  ⚠ Diese VMs liefen noch, obwohl der Server beendet ist —"
    echo "    sie werden OHNE Auto-Commit gestoppt (uncommittete Änderungen"
    echo "    bleiben im Workspace, landen aber nicht im Branch):"
    echo "$vms" | while IFS= read -r vm; do
      # Fehlschlag NICHT verschlucken: mit `&& echo` blieb eine VM, die sich
      # nicht stoppen ließ, unsichtbar — man sah nur, dass sie fehlte, und
      # konnte nicht unterscheiden, ob sie schon gestoppt war oder hängt.
      if msb stop "$vm" >/dev/null 2>&1; then
        echo "    $vm gestoppt"
      else
        status=$(msb list 2>/dev/null | awk -v n="$vm" '$1 == n {print $3}')
        echo "    $vm: msb stop schlug fehl (Status jetzt: ${status:-unbekannt})"
      fi
    done
  else
    echo "  keine verwaisten VMs (der Server hat selbst aufgeräumt)"
  fi
else
  echo "  (msb nicht installiert — übersprungen)"
fi

# Erfolg belegen statt behaupten: hängt noch etwas an einem der Ports, ist der
# nächste `bun run dev` schon am Preflight gescheitert — dann lieber hier ein
# klarer Fehler als später eine verwirrende Meldung.
rest=""
for port in "$WEB_PORT" "$SERVER_PORT" "$EGRESS_PORT" "$GATEWAY_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    rest="$rest :$port"
  fi
done
if [ -n "$rest" ]; then
  echo "✗ Diese Ports sind weiterhin belegt:$rest"
  for port in $rest; do
    echo "  Wer draufsitzt:  lsof -nP -iTCP${port} -sTCP:LISTEN"
  done
  exit 1
fi

echo "✓ macvibes heruntergefahren."
