#!/usr/bin/env bash
# Starts the API server (:4321) and the Vite dev server (:5173) and opens the board in the browser.
# Ctrl+C stops both processes.
set -euo pipefail

cd "$(dirname "$0")"

WEB_URL="http://localhost:5173"

if [ ! -d node_modules ]; then
  echo "▶ Installing dependencies…"
  npm install
fi

pids=()
cleanup() {
  echo
  echo "■ Stopping servers…"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "▶ Starting API server on :4321"
npm run dev:server &
pids+=($!)

echo "▶ Starting web UI on :5173"
npm run dev:web &
pids+=($!)

# Wait until Vite responds (max. 30 s), then open the browser
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "$WEB_URL"; then
    echo "✔ Opening $WEB_URL"
    if command -v open >/dev/null; then
      open "$WEB_URL"
    elif command -v xdg-open >/dev/null; then
      xdg-open "$WEB_URL"
    fi
    break
  fi
  sleep 0.5
done

wait
