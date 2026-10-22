#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POS_HOME=${POS_HOME:-"$ROOT/../floreantpos-2.0.1-beta-64"}
export POS_API_TOKEN="${POS_API_TOKEN:?Set POS_API_TOKEN (32+ chars)}"
test -f "$ROOT/build/pos-api-bridge.jar" || { echo "Run sh api-bridge/build.sh first" >&2; exit 1; }
cd "$POS_HOME"
exec java -Duser.language=en -Duser.country=GB --add-opens=java.base/java.lang=ALL-UNNAMED -cp "$ROOT/build/pos-api-bridge.jar:$POS_HOME/floreantpos.jar" local.pos.api.Main "$@"
