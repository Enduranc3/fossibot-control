#!/bin/sh
# usage: scripts/pack-release.sh <version>  → fossibot-hub-<version>.tar.gz (after `npm run build`)
set -eu
VER=${1:?usage: pack-release.sh <version>}
OUT=$(mktemp -d)
mkdir -p "$OUT/deploy"
cp -R dist/hub dist/web "$OUT/"
cp -R deploy/termux "$OUT/deploy/termux"
rm -f "$OUT/deploy/termux/"*.test.ts
echo "$VER" > "$OUT/VERSION"
tar -czf "fossibot-hub-$VER.tar.gz" -C "$OUT" .
rm -rf "$OUT"
echo "fossibot-hub-$VER.tar.gz"
