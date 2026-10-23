#!/bin/bash
# Experimental: builds the view-hierarchy agent used by
# `serve-sim --experimental-hierarchy-3d` / `serve-sim hierarchy <bundle-id>`.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simhier}"
mkdir -p "$OUT_DIR"

# shellcheck source=../../scripts/serve-sim-arch.sh
source "$HERE/../../scripts/serve-sim-arch.sh"
serve_sim_resolve_arch

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libSimHierarchyInjector.dylib"

xcrun --sdk iphonesimulator clang \
    "${SERVE_SIM_CLANG_ARCH_FLAGS[@]}" \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -fobjc-arc \
    -fmodules \
    -Wall \
    -framework Foundation \
    -framework UIKit \
    -framework QuartzCore \
    -framework CoreGraphics \
    -install_name "@rpath/libSimHierarchyInjector.dylib" \
    -o "$DYLIB" \
    "$HERE/SimHierarchyInjector.m"

echo "Built: $DYLIB"
file "$DYLIB"
