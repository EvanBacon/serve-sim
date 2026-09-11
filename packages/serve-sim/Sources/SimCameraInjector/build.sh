#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simcam}"
mkdir -p "$OUT_DIR"

# shellcheck source=../../scripts/serve-sim-arch.sh
source "$HERE/../../scripts/serve-sim-arch.sh"
serve_sim_resolve_arch

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libSimCameraInjector.dylib"

# Arch list comes from SERVE_SIM_ARCH (default universal).
xcrun --sdk iphonesimulator clang \
    "${SERVE_SIM_CLANG_ARCH_FLAGS[@]}" \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -fobjc-arc \
    -fmodules \
    -fobjc-weak \
    -framework Foundation \
    -framework UIKit \
    -framework AVFoundation \
    -framework CoreImage \
    -framework CoreMedia \
    -framework CoreMotion \
    -framework CoreVideo \
    -framework CoreGraphics \
    -framework IOSurface \
    -framework QuartzCore \
    -install_name "@rpath/libSimCameraInjector.dylib" \
    -o "$DYLIB" \
    "$HERE/SimCameraInjector.m" \
    "$HERE/SimCamLog.m" \
    "$HERE/SimCamFakes.m" \
    "$HERE/SimCamFrameSource.m" \
    "$HERE/SimCamSwizzles.m"

echo "Built: $DYLIB"
file "$DYLIB"
