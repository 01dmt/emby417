#!/usr/bin/env bash
set -euo pipefail

APP_DATA_DIR="/data"
APP_LOG_DIR="/data/logs"
APP_RUNTIME_LOG="${APP_LOG_DIR}/app.log"
WEB_UI_PORT="${WEB_UI_PORT:-8417}"
CANONICAL_HOST="${CANONICAL_HOST:-}"

export APP_DATA_DIR
export APP_LOG_DIR
export CADDYFILE_PATH="/data/Caddyfile.local"
export XDG_DATA_HOME="/data"
export XDG_CONFIG_HOME="/data"
export WEB_UI_PORT
export CANONICAL_HOST

mkdir -p "${APP_DATA_DIR}" "${APP_LOG_DIR}" "${XDG_DATA_HOME}" "${XDG_CONFIG_HOME}"
touch "${APP_RUNTIME_LOG}"

exec > >(tee -a "${APP_RUNTIME_LOG}") 2>&1

echo "[entrypoint] starting caddy"
caddy start

echo "[entrypoint] starting bridge (127.0.0.1:8115)"
python3 -m uvicorn bridge.app:app --host 127.0.0.1 --port 8115 &
BRIDGE_PID=$!

echo "[entrypoint] starting node service (0.0.0.0:${WEB_UI_PORT}) canonical=${CANONICAL_HOST}"
node dist/server.js &
NODE_PID=$!

cleanup() {
  set +e
  if kill -0 "${NODE_PID}" 2>/dev/null; then
    kill "${NODE_PID}" 2>/dev/null
    wait "${NODE_PID}" 2>/dev/null
  fi
  if kill -0 "${BRIDGE_PID}" 2>/dev/null; then
    kill "${BRIDGE_PID}" 2>/dev/null
    wait "${BRIDGE_PID}" 2>/dev/null
  fi
  caddy stop >/dev/null 2>&1
}

trap cleanup EXIT INT TERM

wait -n "${NODE_PID}" "${BRIDGE_PID}"
