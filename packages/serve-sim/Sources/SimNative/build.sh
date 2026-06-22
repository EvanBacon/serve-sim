#!/bin/bash
# Builds serve-sim-native.node — the in-process N-API addon that replaces the
# spawned serve-sim-bin helper. The JS bindings are written in Swift with
# node-swift (see ../../Package.swift and sim-module.swift).
#
# Host-arch only (arm64 on Apple Silicon / CI). We use a plain `swift build`,
# i.e. the NATIVE SwiftPM build system, because that is the only mode that
# resolves node-swift's #NodeModule macro plugin: both `--arch X --arch Y`
# (universal) and `--triple <other-arch>` force Xcode's XCBuild, which fails to
# resolve the NodeAPIMacros plugin on stock toolchains ("missing target
# NodeAPIMacros" / "unable to resolve module SwiftSyntax"). Cross-compiling the
# x86_64 slice would therefore require an x86_64-native toolchain (Rosetta),
# which isn't available everywhere; serve-sim targets Apple Silicon. napi_* stay
# undefined and resolve against the host (Node/Bun) at dlopen via
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

swift build \
  -c release \
  --product "$PRODUCT" \
  --package-path "$PKG" \
  --build-path "$BUILD_DIR" \
  -Xlinker -undefined -Xlinker dynamic_lookup

# `-print -quit` (not `| head`): under `pipefail`, head closing the pipe early
# would SIGPIPE find and fail the script. Match by name rather than a fixed
# subpath: the product dir varies by toolchain (native SwiftPM emits
# .build/release/, the Xcode build system emits .build/out/Products/Release/).
DYLIB="$(find "$BUILD_DIR" -name "lib${PRODUCT}.dylib" -type f -not -path '*.dSYM*' -print -quit)"
if [ -z "$DYLIB" ]; then
  echo "Build succeeded but lib${PRODUCT}.dylib was not found under $BUILD_DIR" >&2
  exit 1
fi

OUT="$OUT_DIR/${PRODUCT}.node"
cp "$DYLIB" "$OUT"
codesign -s - -f "$OUT" 2>/dev/null || true

echo "Built: $OUT"
lipo -info "$OUT"
