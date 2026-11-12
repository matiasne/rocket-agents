#!/usr/bin/env bash
# Runs the whole demo with A2A push notifications working locally: opens an ngrok
# tunnel to the router server and passes its public URL to `pnpm dev` as
# ROUTER_PUBLIC_URL. The tunnel closes when you stop the script (Ctrl+C).
set -euo pipefail
cd "$(dirname "$0")/.."

ROUTER_PORT=4111

# The Mastra CLI needs Node 22.13+ (see .nvmrc). Switch with nvm if the shell is on an older one.
node_ok() { node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; }
if ! node_ok; then
  # nvm.sh is not written for `set -eu`.
  set +eu
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" 2>/dev/null
  nvm use >/dev/null 2>&1
  set -eu
  node_ok || { echo "Node 22.13+ is required (found $(node -v)). Run: nvm install 22" >&2; exit 1; }
fi

command -v ngrok >/dev/null || { echo "ngrok is not installed: https://ngrok.com/download" >&2; exit 1; }

NGROK_LOG=$(mktemp)
ngrok http "$ROUTER_PORT" --log "$NGROK_LOG" --log-format json >/dev/null &
NGROK_PID=$!
trap 'kill "$NGROK_PID" 2>/dev/null; rm -f "$NGROK_LOG"' EXIT

# ngrok logs the public URL once the tunnel is up.
tunnel_url() { grep -o '"url":"https://[^"]*"' "$NGROK_LOG" | head -1 | cut -d'"' -f4; }
for _ in $(seq 1 20); do
  [ -n "$(tunnel_url)" ] && break
  kill -0 "$NGROK_PID" 2>/dev/null || break
  sleep 0.5
done

ROUTER_PUBLIC_URL=$(tunnel_url)
if [ -z "$ROUTER_PUBLIC_URL" ]; then
  echo "ngrok did not open a tunnel:" >&2
  cat "$NGROK_LOG" >&2
  exit 1
fi
export ROUTER_PUBLIC_URL

echo "Tunnel: $ROUTER_PUBLIC_URL -> http://localhost:$ROUTER_PORT"
pnpm dev
