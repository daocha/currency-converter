#!/usr/bin/env bash
# Local development server with auto-reload and debug logging.
# Usage: ./start.sh            (env overrides: PORT, CACHE_TTL_SECONDS, LOG_LEVEL, PYTHON)
set -euo pipefail

cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
VENV=".venv"

if [ ! -d "$VENV" ]; then
  echo "Creating virtualenv in $VENV"
  "$PYTHON" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

# Reinstall only when requirements change.
STAMP="$VENV/.requirements.sha"
SUM="$(cat requirements.txt requirements-dev.txt | shasum | cut -d' ' -f1)"
if [ ! -f "$STAMP" ] || [ "$(cat "$STAMP")" != "$SUM" ]; then
  pip install --upgrade pip >/dev/null
  pip install -r requirements-dev.txt
  echo "$SUM" > "$STAMP"
fi

export CACHE_TTL_SECONDS="${CACHE_TTL_SECONDS:-300}"
LOG_LEVEL="$(printf "%s" "${LOG_LEVEL:-warning}" | tr "[:upper:]" "[:lower:]")"
export LOG_LEVEL
PORT="${PORT:-8000}"

echo "Starting on http://localhost:$PORT (TTL ${CACHE_TTL_SECONDS}s, log level $LOG_LEVEL)"
exec uvicorn app.main:app --reload --reload-dir app --host 0.0.0.0 --port "$PORT" --log-level "$LOG_LEVEL" --no-access-log
