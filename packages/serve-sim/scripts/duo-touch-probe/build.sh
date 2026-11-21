#!/bin/bash
# Build (and optionally install) the touch probe app for the iOS Simulator.
#   build.sh [udid]   → builds to $OUT (default /tmp/serve-sim-touchprobe/TouchProbe.app),
#                       installs into <udid> when given.
# Uses swiftc + an ad-hoc signature; no Xcode project or signing identity needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-/tmp/serve-sim-touchprobe}"
APP="$OUT/TouchProbe.app"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
ARCH="$(uname -m)"
MIN_IOS="${MIN_IOS:-17.0}"

rm -rf "$APP"
mkdir -p "$APP"
xcrun --sdk iphonesimulator swiftc -parse-as-library -O \
  -sdk "$SDK" -target "$ARCH-apple-ios$MIN_IOS-simulator" \
  -o "$APP/TouchProbe" "$HERE/TouchProbe.swift"
cp "$HERE/Info.plist" "$APP/Info.plist"
codesign --force --sign - "$APP" >/dev/null
echo "$APP"

if [ "${1:-}" != "" ]; then
  xcrun simctl install "$1" "$APP"
fi
