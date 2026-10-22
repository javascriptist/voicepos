#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
POS_HOME=${POS_HOME:-"$ROOT/../floreantpos-2.0.1-beta-64"}
sh "$ROOT/build.sh"
mkdir -p "$ROOT/build/test-classes" "$ROOT/build/test-working"
find "$ROOT/test" -name '*.java' -print > "$ROOT/build/test-sources.txt"
javac --release 8 -cp "$ROOT/build/classes:$POS_HOME/floreantpos.jar" -d "$ROOT/build/test-classes" @"$ROOT/build/test-sources.txt"
cd "$ROOT/build/test-working"
exec java --add-opens=java.base/java.lang=ALL-UNNAMED -Djava.awt.headless=true -Dsun.net.http.allowRestrictedHeaders=true -cp "$ROOT/build/test-classes:$ROOT/build/classes:$POS_HOME/floreantpos.jar" local.pos.api.BridgeTest
