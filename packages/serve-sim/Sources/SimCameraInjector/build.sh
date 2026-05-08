#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simcam}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libSimCameraInjector.dylib"

# Build a fat dylib (arm64 + x86_64) for the iphonesimulator SDK.
xcrun --sdk iphonesimulator clang \
    -arch arm64 -arch x86_64 \
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
    -framework CoreVideo \
    -framework CoreGraphics \
    -framework QuartzCore \
    -install_name "@rpath/libSimCameraInjector.dylib" \
    -o "$DYLIB" \
    "$HERE/SimCameraInjector.m"

echo "Built: $DYLIB"
file "$DYLIB"
