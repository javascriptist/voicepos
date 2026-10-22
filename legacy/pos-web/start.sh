#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
export PORT="${PORT:-3000}"
export POS_API_URL="${POS_API_URL:-http://127.0.0.1:8787/v1}"
export POS_API_TOKEN="${POS_API_TOKEN:?Set POS_API_TOKEN (32+ chars)}"
echo "Starting The Crown & Copper Web POS on http://localhost:$PORT..."
exec node server.js
