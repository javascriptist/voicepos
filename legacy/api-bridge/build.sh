#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POS_HOME=${POS_HOME:-"$ROOT/../floreantpos-2.0.1-beta-64"}
test -f "$POS_HOME/floreantpos.jar" || { echo "POS_HOME must contain floreantpos.jar" >&2; exit 1; }
mkdir -p "$ROOT/build/classes"
find "$ROOT/src" -name '*.java' -print > "$ROOT/build/sources.txt"
javac --release 8 -Xlint:unchecked -cp "$POS_HOME/floreantpos.jar" -d "$ROOT/build/classes" @"$ROOT/build/sources.txt"
jar cfe "$ROOT/build/pos-api-bridge.jar" local.pos.api.Main -C "$ROOT/build/classes" .
echo "Built $ROOT/build/pos-api-bridge.jar"
