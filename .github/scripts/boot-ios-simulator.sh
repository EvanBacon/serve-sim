#!/bin/bash
# Boot an iPhone simulator for serve-sim CI. Writes state under
# $SERVE_SIM_BOOT_DIR (default /tmp/serve-sim-boot):
#   udid   — booted device UDID
#   done   — success marker
#   failed — failure marker
#   log    — caller usually redirects stdout/stderr here
set -euo pipefail

# Resolve a UDID that matches NAME (prefer already-booted), then boot that
# UDID. Never publish "first globally booted" — another simulator can already
# be up on the runner.
resolve_udid_for_name() {
  local name="$1"
  local devices_json
  if [[ -n "${SERVE_SIM_DEVICES_JSON:-}" ]]; then
    devices_json=$(cat "$SERVE_SIM_DEVICES_JSON")
  else
    devices_json=$(xcrun simctl list devices -j)
  fi
  printf '%s' "$devices_json" | NAME="$name" node -e '
    const name = process.env.NAME;
    const data = JSON.parse(require("fs").readFileSync(0, "utf-8"));
    let fallback = "";
    for (const [runtime, devs] of Object.entries(data.devices || {})) {
      if (!/iOS/i.test(runtime)) continue;
      for (const d of devs) {
        if (d.name !== name || !d.udid || d.isAvailable === false) continue;
        if (d.state === "Booted") {
          process.stdout.write(d.udid);
          process.exit(0);
        }
        if (!fallback) fallback = d.udid;
      }
    }
    if (fallback) process.stdout.write(fallback);
  '
}

if [[ "${1:-}" == "--resolve-udid" ]]; then
  resolve_udid_for_name "${2:-}"
  printf '\n'
  exit 0
fi

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
  CANDIDATE=$(resolve_udid_for_name "$NAME")
  if [ -z "$CANDIDATE" ]; then
    echo "  skip: no available \"$NAME\""
    continue
  fi
  echo "Trying to boot \"$NAME\" ($CANDIDATE)..."
  if OUT=$(xcrun simctl boot "$CANDIDATE" 2>&1); then
    UDID="$CANDIDATE"
    echo "Booted \"$NAME\" -> $UDID"
    break
  fi
  if printf '%s\n' "$OUT" | grep -qiE 'current state: (Booted|Booting)'; then
    UDID="$CANDIDATE"
    echo "Already booted \"$NAME\" -> $UDID"
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
