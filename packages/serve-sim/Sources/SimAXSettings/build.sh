#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simax}"
mkdir -p "$OUT_DIR"

# shellcheck source=../../scripts/serve-sim-arch.sh
source "$HERE/../../scripts/serve-sim-arch.sh"
serve_sim_resolve_arch

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
BIN="$OUT_DIR/serve-sim-ax-settings"

# Simulator executable for `simctl spawn`. Arch list comes from SERVE_SIM_ARCH
# (default universal).
xcrun --sdk iphonesimulator clang \
    "${SERVE_SIM_CLANG_ARCH_FLAGS[@]}" \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -framework CoreFoundation \
    -o "$BIN" \
    "$HERE/sim-ax-settings.m"

echo "Built: $BIN"
file "$BIN"
