#!/bin/bash
# Builds serve-sim-native.node — the in-process N-API addon that replaces the
# spawned serve-sim-bin helper. The JS bindings are written in Swift with
# node-swift (see ../../Package.swift and sim-module.swift).
#
# We opt into the new `swiftbuild` build system, because it supports building universal
# binaries with macros, which neither the legacy `native` build system nor the
# perennially-janky legacy `xcode` build system had support for.
#
# napi_* stay undefined and resolve against the host (Node/Bun) at dlopen via
# `-undefined dynamic_lookup`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"          # packages/serve-sim (Package.swift root)
OUT_DIR="${1:-$PKG/dist/native}"
BUILD_DIR="$PKG/.build"
PRODUCT="serve-sim-native"
mkdir -p "$OUT_DIR"

if [ ! -d "$PKG/node_modules/node-swift" ]; then
  echo "node-swift not found at $PKG/node_modules/node-swift (run: bun install)" >&2
  exit 1
fi

build_flags=(
  -c release
  --product "$PRODUCT"
  --package-path "$PKG"
  --build-path "$BUILD_DIR"
  --build-system swiftbuild
)
swift build "${build_flags[@]}" >&2
DYLIB="$(swift build --show-bin-path "${build_flags[@]}")/lib${PRODUCT}.dylib"
if [ ! -f "$DYLIB" ]; then
  echo "Expected build product not found at $DYLIB" >&2
  exit 1
fi

OUT="$OUT_DIR/${PRODUCT}.node"
cp -a "$DYLIB" "$OUT"
strip -x "$OUT"
codesign -s - -f "$OUT" 2>/dev/null || true

echo "Built: $OUT"
lipo -info "$OUT"
