#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simcam}"
mkdir -p "$OUT_DIR"

# shellcheck source=../../scripts/serve-sim-arch.sh
source "$HERE/../../scripts/serve-sim-arch.sh"
serve_sim_resolve_arch

SDK="$(xcrun --sdk macosx --show-sdk-path)"
BIN="$OUT_DIR/serve-sim-camera-helper"

xcrun --sdk macosx clang \
    "${SERVE_SIM_CLANG_ARCH_FLAGS[@]}" \
    -mmacosx-version-min=14.0 \
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
    -framework IOSurface \
    -framework Accelerate \
    -O2 \
    -o "$BIN" \
    "$HERE/main.m"

# Re-sign so the camera privacy prompt persists per-build instead of restarting.
codesign -s - -f "$BIN" 2>/dev/null || true

echo "Built: $BIN"
file "$BIN"
