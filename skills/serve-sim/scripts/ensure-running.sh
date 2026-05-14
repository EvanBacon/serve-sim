#!/usr/bin/env bash
# Ensure a serve-sim helper is running for the booted simulator.
# Idempotent: if one is already running, prints its URL JSON and exits 0.
# Otherwise starts a detached one and prints the spawn JSON.
# Usage: ensure-running.sh [device-name-or-udid]

set -u

DEVICE="${1:-}"

# If a helper is already running for any device, return it
EXISTING="$(npx --yes serve-sim --list -q 2>/dev/null || echo '[]')"
if [[ "$EXISTING" != "[]" && -n "$EXISTING" ]]; then
  if [[ -n "$DEVICE" ]]; then
    MATCH="$(echo "$EXISTING" | node -e "
      const arr = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const d = process.argv[1].toLowerCase();
      const m = arr.find(x => (x.device || '').toLowerCase().includes(d) || x.udid === d);
      if (m) console.log(JSON.stringify(m));
    " "$DEVICE")"
    if [[ -n "$MATCH" ]]; then
      echo "$MATCH"
      exit 0
    fi
  else
    # No specific device requested — return the first running one
    echo "$EXISTING" | node -e "
      const arr = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      if (arr[0]) console.log(JSON.stringify(arr[0]));
    "
    exit 0
  fi
fi

# Start a new detached helper
if [[ -n "$DEVICE" ]]; then
  npx --yes serve-sim --detach -q "$DEVICE"
else
  npx --yes serve-sim --detach -q
fi
