#!/usr/bin/env bash
# Local development server with auto-reload.
# Stops a previously started dev server of this project (same PID file or same port) before starting.
# Usage: ./start.sh            (env overrides: PORT, CACHE_TTL_SECONDS, LOG_LEVEL, PYTHON)
set -euo pipefail

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd -P)"

PYTHON="${PYTHON:-python3}"
VENV=".venv"
PIDFILE=".server.pid"
PORT="${PORT:-8000}"

# Working directory of a process (macOS via lsof, Linux via /proc).
proc_cwd() {
  if [ -e "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null || true
  elif command -v lsof >/dev/null; then
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  fi
}

# True only for this project's uvicorn (the reloader or its worker), never for unrelated programs.
is_our_server() {
  local pid="$1" cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  case "$cmd" in
    *"app.main:app"* | *"multiprocessing"*) ;;
    *) return 1 ;;
  esac
  [ "$(proc_cwd "$pid")" = "$PROJECT_DIR" ]
}

stop_pid() {
  local pid="$1" i
  kill -TERM "$pid" 2>/dev/null || return 0
  for i in $(seq 1 50); do  # up to 10s for a graceful shutdown
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  echo "PID $pid did not exit; killing it"
  kill -KILL "$pid" 2>/dev/null || true
}

listening_pids() {
  # lsof exits 1 when nothing listens; that's fine here.
  command -v lsof >/dev/null && lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' || true
}

stop_existing() {
  local pid stopped=""
  # Check the port first, so a conflict with another program doesn't stop our running server.
  for pid in $(listening_pids); do
    if ! is_our_server "$pid"; then
      echo "Port $PORT is in use by another program (PID $pid: $(ps -o command= -p "$pid" | cut -c1-80))." >&2
      echo "Stop it or choose another port, e.g. PORT=8001 ./start.sh" >&2
      exit 1
    fi
  done
  for pid in $([ -f "$PIDFILE" ] && cat "$PIDFILE") $(listening_pids); do
    case " $stopped " in *" $pid "*) continue ;; esac
    if is_our_server "$pid"; then
      echo "Stopping existing server (PID $pid)"
      stop_pid "$pid"
      stopped="$stopped $pid"
    fi
  done
  rm -f "$PIDFILE"
}

stop_existing

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

echo "Starting on http://localhost:$PORT (TTL ${CACHE_TTL_SECONDS}s, log level $LOG_LEVEL)"
# exec keeps this PID, so the PID file points at the uvicorn reloader process.
echo $$ > "$PIDFILE"
exec uvicorn app.main:app --reload --reload-dir app --host 0.0.0.0 --port "$PORT" --log-level "$LOG_LEVEL" --no-access-log
