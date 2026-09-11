#!/bin/bash
# Wait for boot-ios-simulator.sh (possibly started in another workflow step).
set -euo pipefail

STATE_DIR="${SERVE_SIM_BOOT_DIR:-/tmp/serve-sim-boot}"
TIMEOUT_SEC="${SERVE_SIM_BOOT_TIMEOUT_SEC:-600}"
PID_FILE="$STATE_DIR/pid"
DEADLINE=$((SECONDS + TIMEOUT_SEC))

while (( SECONDS < DEADLINE )); do
  if [[ -f "$STATE_DIR/done" ]]; then
    UDID=$(cat "$STATE_DIR/udid")
    echo "Simulator booted: $UDID"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      echo "udid=$UDID" >> "$GITHUB_OUTPUT"
    fi
    exit 0
  fi
  if [[ -f "$STATE_DIR/failed" ]]; then
    echo "Simulator boot failed:" >&2
    [[ -f "$STATE_DIR/log" ]] && cat "$STATE_DIR/log" >&2
    exit 1
  fi
  if [[ -f "$PID_FILE" ]]; then
    PID=$(cat "$PID_FILE")
    if [[ -n "$PID" ]] && ! kill -0 "$PID" 2>/dev/null; then
      # Process exited without writing done/failed.
      sleep 1
      if [[ -f "$STATE_DIR/done" ]]; then
        continue
      fi
      echo "Simulator boot process $PID exited unexpectedly:" >&2
      [[ -f "$STATE_DIR/log" ]] && cat "$STATE_DIR/log" >&2
      exit 1
    fi
  fi
  sleep 2
done

echo "Timed out waiting ${TIMEOUT_SEC}s for simulator boot" >&2
[[ -f "$STATE_DIR/log" ]] && cat "$STATE_DIR/log" >&2
exit 1
