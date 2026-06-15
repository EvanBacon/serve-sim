#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building serve-sim-bin (arm64)..."

SWIFT_BUILD_ARGS=(-c release --arch arm64 --build-path .build)

swift build "${SWIFT_BUILD_ARGS[@]}"
BIN_DIR="$(swift build "${SWIFT_BUILD_ARGS[@]}" --show-bin-path)"

mkdir -p bin
cp "$BIN_DIR/serve-sim-bin" bin/serve-sim-bin

# Re-sign after copy (required for framework linking)
codesign -s - -f bin/serve-sim-bin 2>/dev/null

echo "Built: bin/serve-sim-bin"
