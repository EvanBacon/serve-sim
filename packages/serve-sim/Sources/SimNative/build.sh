#!/bin/bash
# Builds serve-sim-native.node — the in-process N-API addon that replaces the
# spawned serve-sim-bin helper. The JS bindings are written in Swift with
# node-swift (see ../../Package.swift and sim-module.swift).
#
# We use a plain `swift build`, i.e. the NATIVE SwiftPM build system, because
# that is the only mode that resolves node-swift's #NodeModule macro plugin: both
# `--arch X --arch Y` (universal) and `--triple <other-arch>` force Xcode's XCBuild,
# which fails to resolve the NodeAPIMacros plugin on stock toolchains ("missing target
# NodeAPIMacros" / "unable to resolve module SwiftSyntax").
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

build_arch() {
  build_flags=(
    -c release
    --enable-experimental-prebuilts
    --product "$PRODUCT"
    --package-path "$PKG"
    --build-path "$BUILD_DIR"
    --arch "$1"
  )
  swift build "${build_flags[@]}" >&2
  DYLIB="$(swift build --show-bin-path "${build_flags[@]}")/lib${PRODUCT}.dylib"
  if [ ! -f "$DYLIB" ]; then
    echo "Expected build product not found at $DYLIB" >&2
    exit 1
  fi
  echo "$DYLIB"
}

arm64_dylib="$(build_arch arm64)"
x64_dylib="$(build_arch x86_64)"

OUT="$OUT_DIR/${PRODUCT}.node"
lipo -create -output "$OUT" "$arm64_dylib" "$x64_dylib"
strip -x "$OUT"
codesign -s - -f "$OUT" 2>/dev/null || true

echo "Built: $OUT"
lipo -info "$OUT"
