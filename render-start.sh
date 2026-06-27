#!/bin/sh
set -eu

LAVALINK_PORT="${LAVALINK_PORT:-2333}"

export LAVALINK_URL="127.0.0.1:${LAVALINK_PORT}"
export LAVALINK_PASSWORD="${LAVALINK_PASSWORD:-droTunesLocalLava2026!}"
export LAVALINK_SECURE="${LAVALINK_SECURE:-false}"
export LAVALINK_SERVER_PASSWORD="${LAVALINK_PASSWORD}"

echo "Starting Lavalink privately on ${LAVALINK_URL}..."
(
  cd /app/lavalink
  exec java -jar Lavalink.jar --server.address=127.0.0.1 --server.port="${LAVALINK_PORT}"
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
  if node -e "const net=require('node:net'); const socket=net.connect(${LAVALINK_PORT},'127.0.0.1'); socket.once('connect',()=>{socket.destroy(); process.exit(0);}); socket.once('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),1000);"; then
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

echo "Starting bot..."
exec node dist/index.js
