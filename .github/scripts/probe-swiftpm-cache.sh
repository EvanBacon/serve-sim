#!/bin/bash
# Simulate a GitHub Actions cache restore of packages/serve-sim/.build.
#
# After a successful `bun run build.ts`, tar the SwiftPM graph, wipe it, restore
# from the archive (mtime-preserving, like actions/cache), and rebuild. A warm
# hit is seconds/low tens — not another ~200s cold swift-syntax compile.
#
# Prints GITHUB_OUTPUT keys:
#   rebuild_seconds
#   warm=true|false
#   verdict
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKG="$ROOT/packages/serve-sim"
BUILD_DIR="$PKG/.build"
ARCHIVE="${SERVE_SIM_SWIFTPM_PROBE_ARCHIVE:-/tmp/serve-sim-swiftpm-build.tar}"
# "near-warm (seconds/low tens), not another ~200s cold compile"
WARM_BUDGET_SEC="${SERVE_SIM_SWIFTPM_WARM_BUDGET_SEC:-60}"
ARCH="${SERVE_SIM_ARCH:-arm64}"

if [[ ! -d "$BUILD_DIR" ]]; then
  echo "probe-swiftpm-cache: $BUILD_DIR does not exist (build first)" >&2
  exit 1
fi

echo "Archiving $BUILD_DIR -> $ARCHIVE"
rm -f "$ARCHIVE"
tar -C "$PKG" -cf "$ARCHIVE" .build

echo "Wiping .build and dist to simulate a clean tree + cache restore"
rm -rf "$BUILD_DIR" "$PKG/dist"
tar -C "$PKG" -xf "$ARCHIVE"

echo "Rebuilding with restored .build (SERVE_SIM_ARCH=$ARCH)"
START=$(date +%s)
(
  cd "$PKG"
  SERVE_SIM_ARCH="$ARCH" bun run build.ts
)
END=$(date +%s)
ELAPSED=$((END - START))

NODE="$PKG/dist/native/serve-sim-native.node"
if [[ ! -f "$NODE" ]]; then
  echo "probe-swiftpm-cache: missing $NODE after restore rebuild" >&2
  VERDICT="BROKEN"
  WARM=false
elif (( ELAPSED <= WARM_BUDGET_SEC )); then
  VERDICT="WARM_HIT"
  WARM=true
else
  VERDICT="NO_SPEEDUP"
  WARM=false
fi

echo "SWIFTPM_CACHE_PROBE restore_rebuild_s=$ELAPSED budget_s=$WARM_BUDGET_SEC verdict=$VERDICT"
if command -v lipo >/dev/null 2>&1; then
  echo "SWIFTPM_CACHE_PROBE native=$(lipo -info "$NODE" 2>/dev/null || echo missing)"
fi

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "rebuild_seconds=$ELAPSED" >> "$GITHUB_OUTPUT"
  echo "warm=$WARM" >> "$GITHUB_OUTPUT"
  echo "verdict=$VERDICT" >> "$GITHUB_OUTPUT"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### SwiftPM .build restore probe"
    echo ""
    echo "- restore rebuild: **${ELAPSED}s** (warm budget ${WARM_BUDGET_SEC}s)"
    echo "- verdict: \`${VERDICT}\`"
    echo "- SERVE_SIM_ARCH: \`${ARCH}\`"
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [[ "$WARM" != "true" ]]; then
  echo "::warning title=SwiftPM cache probe::$VERDICT — restore rebuild took ${ELAPSED}s (budget ${WARM_BUDGET_SEC}s). Do not keep a decorative cache."
fi
