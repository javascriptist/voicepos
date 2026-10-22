#!/usr/bin/env bash
# Starts the Sora voice agent on Agora and points its tools at this server's public tunnel.
# Usage: ./launch-sora-agent.sh [https://your-public-url]   (default: auto-detect ngrok)
#        ./launch-sora-agent.sh stop | status
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Prefer AGORA_CUSTOMER_ID/AGORA_CUSTOMER_SECRET (they don't expire). Tokens below expire and must be refreshed.
export AGORA_APP_ID="${AGORA_APP_ID:?Set AGORA_APP_ID (your Agora project App ID)}"
if [ -z "${AGORA_CUSTOMER_ID:-}" ]; then
  export AGORA_AUTH_TOKEN="${AGORA_AUTH_TOKEN:?Set AGORA_AUTH_TOKEN (or AGORA_CUSTOMER_ID/SECRET)}"
fi

case "${1:-}" in
  stop) exec node agora-agent.js leave ;;
  status) exec node agora-agent.js status ;;
esac

TUNNEL_URL="${1:-${PUBLIC_URL:-}}"
if [ -n "$TUNNEL_URL" ]; then
  echo "Connecting Sora Voice Assistant to POS API at: $TUNNEL_URL"
fi

# Fail fast if the tools would hit a dead server.
if ! curl -s -m 3 -o /dev/null http://127.0.0.1:${PORT:-3000}/api/health; then
  echo "Warning: the web POS server is not responding on port ${PORT:-3000}. Start it with ./start.sh." >&2
fi

node agora-agent.js join ${TUNNEL_URL:+"$TUNNEL_URL"}
echo "Sora is active. Stop it with: ./launch-sora-agent.sh stop"
