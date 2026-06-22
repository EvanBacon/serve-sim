#!/bin/bash
# Builds serve-sim-native.node — the in-process N-API addon that replaces the
# spawned serve-sim-bin helper. The JS bindings are written in Swift with
# node-swift (see ../../Package.swift and sim-module.swift).
#
# We drive `swift build` directly rather than `node-swift rebuild` for two
# reasons: we need a universal (arm64 + x86_64) binary, which we get from
# `--arch arm64 --arch x86_64` (native multi-arch on the host toolchain, so the
# #NodeModule macro keeps working — cross-compiling per-arch with `--triple`
# breaks macros); and we emit to a fixed dist path. napi_* symbols stay
# undefined and resolve against the host (Node/Bun) at dlopen via
# `-undefined dynamic_lookup`, exactly as node-swift's own builder does.
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
  --arch arm64 --arch x86_64 \
  --package-path "$PKG" \
  --build-path "$BUILD_DIR" \
  -Xlinker -undefined -Xlinker dynamic_lookup

# With --arch, the merged universal dylib lives under Products/Release while
# single-arch slices sit in per-arch intermediate dirs; pick the fat one.
DYLIB=""
while IFS= read -r f; do
  case "$(lipo -archs "$f" 2>/dev/null)" in
    *arm64*x86_64* | *x86_64*arm64*) DYLIB="$f"; break ;;
  esac
done < <(find "$BUILD_DIR" -name "lib${PRODUCT}.dylib" -type f -not -path '*.dSYM*')

if [ -z "$DYLIB" ]; then
  echo "Build succeeded but no universal lib${PRODUCT}.dylib was found under $BUILD_DIR" >&2
  exit 1
fi

OUT="$OUT_DIR/${PRODUCT}.node"
cp "$DYLIB" "$OUT"
codesign -s - -f "$OUT" 2>/dev/null || true

echo "Built: $OUT"
lipo -info "$OUT"
