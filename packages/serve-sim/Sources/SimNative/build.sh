#!/bin/bash
# Builds serve-sim-native.node — the in-process N-API addon that replaces the
# spawned serve-sim-bin helper. Mirrors the SimCameraHelper build.sh fat-binary
# pattern, but the final per-arch link is done with `swiftc` so the Swift
# runtime is linked correctly; napi_* symbols stay undefined and resolve against
# the host (Node/Bun) at dlopen time via `-undefined dynamic_lookup`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/native}"
mkdir -p "$OUT_DIR"

# node-api-headers ships the ABI-stable C headers; N-API is version-independent
# so a single prebuilt .node works across all supported Node versions.
NAPI_INC="$HERE/../../node_modules/node-api-headers/include"
if [ ! -f "$NAPI_INC/node_api.h" ]; then
  echo "node-api-headers not found at $NAPI_INC (run: bun install)" >&2
  exit 1
fi

SDK="$(xcrun --sdk macosx --show-sdk-path)"
MIN=14.0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Swift sources: the SimNative C-ABI shims + the SimStreamHelper logic they
# reuse verbatim (HIDInjector and its deps). They compile as one Swift module,
# so internal symbols resolve across files.
STREAM="$HERE/../SimStreamHelper"
SWIFT_SRC=(
  "$HERE/sim-native.swift"
  "$HERE/sim-hid.swift"
  "$HERE/sim-capture.swift"
  "$HERE/sim-ax.swift"
  "$STREAM/HIDInjector.swift"
  "$STREAM/FrameCapture.swift"
  "$STREAM/VideoEncoder.swift"
  "$STREAM/H264Encoder.swift"
  "$STREAM/StreamFormat.swift"
  "$STREAM/AccessibilityBridge.swift"
  "$STREAM/SimFrameworks.swift"
  "$STREAM/Xcode.swift"
)

SLICES=()
for ARCH in arm64 x86_64; do
  # Objective-C++ N-API glue → object (clang++).
  xcrun --sdk macosx clang++ \
    -arch "$ARCH" -mmacosx-version-min="$MIN" -isysroot "$SDK" \
    -std=c++17 -fobjc-arc -O2 \
    -I "$NAPI_INC" \
    -c "$HERE/sim-native.mm" -o "$TMP/glue-$ARCH.o"

  # Swift sources + glue object → per-arch dylib (swiftc links the Swift
  # runtime + autolinks imported frameworks). napi_* stay undefined and resolve
  # against the host at dlopen via -undefined dynamic_lookup.
  xcrun --sdk macosx swiftc \
    -target "$ARCH-apple-macosx$MIN" \
    -O -emit-library \
    -o "$TMP/native-$ARCH.dylib" \
    "${SWIFT_SRC[@]}" "$TMP/glue-$ARCH.o" \
    -framework CoreVideo -framework CoreMedia -framework IOSurface -framework CoreGraphics \
    -framework VideoToolbox -framework ImageIO -framework CoreFoundation -framework AppKit \
    -Xlinker -undefined -Xlinker dynamic_lookup
  SLICES+=("$TMP/native-$ARCH.dylib")
done

OUT="$OUT_DIR/serve-sim-native.node"
lipo -create "${SLICES[@]}" -output "$OUT"
codesign -s - -f "$OUT" 2>/dev/null || true

echo "Built: $OUT"
file "$OUT"
