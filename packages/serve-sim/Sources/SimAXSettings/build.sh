#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simax}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
BIN="$OUT_DIR/serve-sim-ax-settings"

# Build a fat simulator executable (arm64 + x86_64); it runs inside the sim
# via `simctl spawn`.
xcrun --sdk iphonesimulator clang \
    -arch arm64 -arch x86_64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -framework CoreFoundation \
    -o "$BIN" \
    "$HERE/sim-ax-settings.m"

echo "Built: $BIN"
file "$BIN"
