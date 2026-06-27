#!/bin/sh
set -eu

# 1. Dynamically capture Render's port (defaults to 2333 for local testing)
TARGET_PORT="${PORT:-2333}"

# 2. Update your bot's environment variables to use the correct dynamic port
export LAVALINK_URL="${LAVALINK_URL:-127.0.0.1:${TARGET_PORT}}"
export LAVALINK_PASSWORD="${LAVALINK_PASSWORD:-droTunesLocalLava2026!}"
export LAVALINK_SECURE="${LAVALINK_SECURE:-false}"
export LAVALINK_SERVER_PASSWORD="${LAVALINK_PASSWORD}"

echo "Starting Lavalink on port ${TARGET_PORT}..."
(
  cd /app/lavalink
  # Override Lavalink's internal port using the standard system property
  exec java -Dserver.port="${TARGET_PORT}" -jar Lavalink.jar
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
  # 3. Updated Node snippet to dynamically check TARGET_PORT instead of a hardcoded 2333
  if node -e "const net=require('node:net'); const socket=net.connect(${TARGET_PORT},'127.0.0.1'); socket.once('connect',()=>{socket.destroy(); process.exit(0);}); socket.once('error',()=>process.exit(1)); setTimeout(()=>process.exit(1),1000);"; then
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

