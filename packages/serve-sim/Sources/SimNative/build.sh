#!/bin/bash
# Builds serve-sim-native.node — the in-process N-API addon that replaces the
# spawned serve-sim-bin helper. The JS bindings are written in Swift with
# node-swift (see ../../Package.swift and sim-module.swift).
#
# We opt into the new `swiftbuild` build system, because it supports building
# universal binaries with macros (`SERVE_SIM_ARCH=universal`, the default),
# which neither the legacy `native` build system nor the perennially-janky
# legacy `xcode` build system had support for. CI test jobs set
# SERVE_SIM_ARCH=arm64 to skip the x86_64 slice.
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

# shellcheck source=../../scripts/serve-sim-arch.sh
source "$HERE/../../scripts/serve-sim-arch.sh"
serve_sim_resolve_arch

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
  "${SERVE_SIM_SWIFT_ARCH_FLAGS[@]}"
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
