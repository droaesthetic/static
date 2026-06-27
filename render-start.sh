#!/bin/sh
set -eu

LAVALINK_PORT="${LAVALINK_PORT:-2333}"

export LAVALINK_URL="127.0.0.1:${LAVALINK_PORT}"
export LAVALINK_PASSWORD="${LAVALINK_PASSWORD:-droTunesLocalLava2026!}"
export LAVALINK_SECURE="${LAVALINK_SECURE:-false}"
export LAVALINK_SERVER_PASSWORD="${LAVALINK_PASSWORD}"
export YOUTUBE_OAUTH_ENABLED="${YOUTUBE_OAUTH_ENABLED:-false}"
export YOUTUBE_OAUTH_SKIP_INITIALIZATION="${YOUTUBE_OAUTH_SKIP_INITIALIZATION:-true}"
export LAVALINK_JAVA_OPTS="${LAVALINK_JAVA_OPTS:--Xmx384m}"

if [ "${RUN_LOCAL_LAVALINK:-true}" = "true" ]; then
  echo "Starting Lavalink privately on ${LAVALINK_URL}..."
  (
    cd /app/lavalink
    exec java ${LAVALINK_JAVA_OPTS} -jar Lavalink.jar --server.address=127.0.0.1 --server.port="${LAVALINK_PORT}"
  ) &
  LAVALINK_PID="$!"

  cleanup() {
    if kill -0 "$LAVALINK_PID" 2>/dev/null; then
      kill "$LAVALINK_PID" 2>/dev/null || true
    fi
  }
  trap cleanup INT TERM EXIT

  echo "Waiting for Lavalink on ${LAVALINK_URL}..."
  for attempt in $(seq 1 90); do
    if curl -fsS -H "Authorization: ${LAVALINK_PASSWORD}" "http://${LAVALINK_URL}/version" >/dev/null 2>&1; then
      echo "Lavalink is ready."
      break
    fi

    if ! kill -0 "$LAVALINK_PID" 2>/dev/null; then
      echo "Lavalink exited before it became ready."
      wait "$LAVALINK_PID"
      exit 1
    fi

    if [ "$attempt" -eq 90 ]; then
      echo "Timed out waiting for Lavalink."
      exit 1
    fi

    sleep 1
  done

  sleep 3
else
  echo "Skipping local Lavalink. Using external Lavalink at ${LAVALINK_URL}."
fi

echo "Starting bot..."
exec node dist/index.js
