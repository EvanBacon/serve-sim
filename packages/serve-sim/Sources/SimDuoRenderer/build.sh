#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simduo}"
mkdir -p "$OUT_DIR"
source "$HERE/../../scripts/serve-sim-arch.sh"
serve_sim_resolve_arch
case "$SERVE_SIM_ARCH_RESOLVED" in
  universal) DUO_ARCHS=(arm64 x86_64);;
  *) DUO_ARCHS=("$SERVE_SIM_ARCH_RESOLVED");;
esac
# RealityRenderer is available on macOS 15+. Older hosts can still use the 2D stream.
for arch in "${DUO_ARCHS[@]}"; do
  xcrun swiftc -O -parse-as-library -target "$arch-apple-macos15.0" \
    "$HERE/DuoRenderer.swift" "$HERE/DuoShellMaterials.swift" "$HERE/main.swift" -o "$OUT_DIR/serve-sim-duo-render-$arch"
done
xcrun lipo -create "${DUO_ARCHS[@]/#/$OUT_DIR/serve-sim-duo-render-}" -output "$OUT_DIR/serve-sim-duo-render"
for arch in "${DUO_ARCHS[@]}"; do rm "$OUT_DIR/serve-sim-duo-render-$arch"; done
