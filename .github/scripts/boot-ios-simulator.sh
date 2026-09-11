#!/bin/bash
# Boot an iPhone simulator for serve-sim CI. Writes state under
# $SERVE_SIM_BOOT_DIR (default /tmp/serve-sim-boot):
#   udid   — booted device UDID
#   done   — success marker
#   failed — failure marker
#   log    — caller usually redirects stdout/stderr here
set -euo pipefail

STATE_DIR="${SERVE_SIM_BOOT_DIR:-/tmp/serve-sim-boot}"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/done" "$STATE_DIR/failed" "$STATE_DIR/udid"

on_fail() {
  echo "boot-ios-simulator failed" >&2
  touch "$STATE_DIR/failed"
}
trap on_fail ERR

UDID=""
for NAME in "iPhone 17 Pro" "iPhone 16 Pro" "iPhone 16" "iPhone 15 Pro" "iPhone 15"; do
  echo "Trying to boot \"$NAME\"..."
  if OUT=$(xcrun simctl boot "$NAME" 2>&1); then
    UDID=$(xcrun simctl list devices booted -j | node -e "
      const data = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
      for (const devs of Object.values(data.devices)) {
        for (const d of devs) { console.log(d.udid); process.exit(0); }
      }
    ")
    echo "Booted \"$NAME\" -> $UDID"
    break
  fi
  echo "  skip: $OUT"
done

if [ -z "$UDID" ]; then
  echo "No pre-created iPhone simulator booted; creating one from the latest runtime"
  RUNTIME=$(xcrun simctl list runtimes -j | node -e "
    const data = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
    const ios = data.runtimes.filter(r => r.isAvailable && r.identifier.includes('iOS'));
    ios.sort((a, b) => a.version.localeCompare(b.version));
    console.log(ios[ios.length - 1].identifier);
  ")
  DEVICETYPE=$(xcrun simctl list devicetypes -j | node -e "
    const data = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
    const iphones = data.devicetypes.filter(d => d.identifier.includes('iPhone'));
    console.log(iphones[iphones.length - 1].identifier);
  ")
  UDID=$(xcrun simctl create "ci-test-iphone" "$DEVICETYPE" "$RUNTIME")
  xcrun simctl boot "$UDID" || true
fi

xcrun simctl bootstatus "$UDID" -b
open -ga Simulator || true

printf '%s\n' "$UDID" > "$STATE_DIR/udid"
touch "$STATE_DIR/done"
trap - ERR
echo "Simulator ready: $UDID"
