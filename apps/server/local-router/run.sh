#!/usr/bin/env bash
# Startet den lokalen Modell-Router (LiteLLM) — wird von macvibes automatisch
# aufgerufen (localRouterService), kann aber auch manuell laufen.
#
#   Endpunkt:  http://localhost:8787/v1/messages  (Anthropic-Format)
#   Backend:   Ollama auf http://localhost:11434
#
# Die Python-venv lebt AUSSERHALB des Repos (~/macvibes/local-router-venv) und
# wird beim allerersten Start automatisch angelegt (dauert einmalig ~1–2 min).
set -euo pipefail
cd "$(dirname "$0")"

PORT="${MACVIBES_LOCAL_ROUTER_PORT:-8787}"
VENV="${MACVIBES_HOME:-$HOME/macvibes}/local-router-venv"

if [[ ! -x "$VENV/bin/litellm" ]]; then
  echo "LiteLLM-venv fehlt — lege sie einmalig an unter $VENV …"
  PY="$(command -v python3.11 || command -v python3)"
  "$PY" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet 'litellm[proxy]'
  echo "LiteLLM installiert."
fi

exec "$VENV/bin/litellm" --config litellm_config.yaml --port "$PORT" --host 127.0.0.1
