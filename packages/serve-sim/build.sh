#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building serve-sim-bin (arm64)..."

export DEVELOPER_DIR=$(xcode-select -p)

swift build \
    -c release \
    --arch arm64 \
    --build-path .build

mkdir -p bin
cp .build/arm64-apple-macosx/release/serve-sim-bin bin/serve-sim-bin

# Re-sign after copy (required for framework linking)
codesign -s - -f bin/serve-sim-bin 2>/dev/null

echo "Built: bin/serve-sim-bin"
