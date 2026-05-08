#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simcam}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk macosx --show-sdk-path)"
BIN="$OUT_DIR/serve-sim-camera-helper"

xcrun --sdk macosx clang \
    -arch arm64 -arch x86_64 \
    -mmacosx-version-min=12.0 \
    -isysroot "$SDK" \
    -fobjc-arc -fmodules \
    -framework Foundation \
    -framework AVFoundation \
    -framework CoreMedia \
    -framework CoreVideo \
    -framework CoreGraphics \
    -framework CoreImage \
    -framework CoreText \
    -framework ImageIO \
    -framework Accelerate \
    -O2 \
    -o "$BIN" \
    "$HERE/main.m"

# Re-sign so the camera privacy prompt persists per-build instead of restarting.
codesign -s - -f "$BIN" 2>/dev/null || true

echo "Built: $BIN"
file "$BIN"
