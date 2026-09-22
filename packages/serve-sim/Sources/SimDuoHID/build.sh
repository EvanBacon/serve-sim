#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simduo}"
mkdir -p "$OUT_DIR"

# shellcheck source=../../scripts/serve-sim-arch.sh
source "$HERE/../../scripts/serve-sim-arch.sh"
serve_sim_resolve_arch

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
BIN="$OUT_DIR/serve-sim-duo-hid"

# Simulator executable for `simctl spawn`. Arch list comes from SERVE_SIM_ARCH
# (default universal).
xcrun --sdk iphonesimulator clang \
    "${SERVE_SIM_CLANG_ARCH_FLAGS[@]}" \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -fobjc-arc -framework Foundation -Wl,-adhoc_codesign \
    -o "$BIN" \
    "$HERE/main.m"

echo "Built: $BIN"
file "$BIN"
