#!/usr/bin/env bash
# Startet API-Server (:4321) und Vite-Dev-Server (:5173) und öffnet das Board im Browser.
# Ctrl+C beendet beide Prozesse.
set -euo pipefail

cd "$(dirname "$0")"

WEB_URL="http://localhost:5173"

if [ ! -d node_modules ]; then
  echo "▶ Installiere Abhängigkeiten…"
  npm install
fi

pids=()
cleanup() {
  echo
  echo "■ Beende Server…"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "▶ Starte API-Server auf :4321"
npm run dev:server &
pids+=($!)

echo "▶ Starte Web-UI auf :5173"
npm run dev:web &
pids+=($!)

# Warten, bis Vite antwortet (max. 30 s), dann Browser öffnen
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "$WEB_URL"; then
    echo "✔ Öffne $WEB_URL"
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
