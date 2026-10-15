#!/bin/sh
# Runs the local-mode tests the way an installed package runs: every native
# library built into npm/ is placed in node_modules as its package, and the
# loader picks the one for this machine. Runs inside a node container.
set -eu
cd "$(dirname "$0")/.."

npm install --no-audit --no-fund --loglevel=error
mkdir -p node_modules/@valkv
found=0
for dir in npm/*/; do
  suffix="$(basename "$dir")"
  rm -rf "node_modules/@valkv/edgekv-$suffix"
  if [ -f "$dir/edgekv.$suffix.node" ]; then
    cp -r "$dir" "node_modules/@valkv/edgekv-$suffix"
    found=1
  fi
done
if [ "$found" = 0 ]; then
  echo "no native library in npm/: build one first (make native-gnu or make native-musl)" >&2
  exit 1
fi
npm run typecheck
npm run test:local
