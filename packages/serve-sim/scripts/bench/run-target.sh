#!/usr/bin/env bash
# Start a serve-sim build in the foreground on PORT, run bench-stream.ts against
# it for each codec, then stop it. State files are isolated under a private
# TMPDIR so concurrent serve-sim sessions on this machine are not affected.
#
#   run-target.sh <label> <port> <outdir> <serve-sim command...>
#   e.g. run-target.sh v0.1.43 4110 ~/bench node /tmp/ssv/0.1.43/node_modules/serve-sim/dist/serve-sim.js
set -euo pipefail
LABEL=$1; PORT=$2; OUTDIR=$3; shift 3
UDID=${UDID:?set UDID to the simulator to benchmark}
CODECS=${CODECS:-"avcc mjpeg"}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUTDIR" "/tmp/ssperf-tmp/$LABEL"
LOG="$OUTDIR/$LABEL.server.log"
# BROWSER=1 runs the preview UI and drives it in Chromium (decode + paint included).
PREVIEW_FLAG=--no-preview; [ -n "${BROWSER:-}" ] && PREVIEW_FLAG=""
TMPDIR="/tmp/ssperf-tmp/$LABEL/" "$@" $PREVIEW_FLAG --port "$PORT" "$UDID" >"$LOG" 2>&1 &
PID=$!
cleanup() {
  kill -INT "$PID" 2>/dev/null || true; sleep 1
  for p in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null); do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT
for _ in $(seq 1 60); do grep -qE "Stream:|Local:" "$LOG" && break; sleep 0.5; done
STREAM=$(grep -m1 "Stream:" "$LOG" | awk '{print $2}' || true)
WS=$(grep -m1 "WebSocket:" "$LOG" | awk '{print $2}' || true)
BASE=${STREAM%/stream.mjpeg}
# The preview server prints only its own URL; devices live under /helper/<udid>.
[ -z "$BASE" ] && BASE="http://127.0.0.1:$PORT/helper/$UDID" && WS="ws://127.0.0.1:$PORT/helper/$UDID/ws"
echo "[$LABEL] base=$BASE"
sleep 2
for codec in $CODECS; do
  KIND_ARGS=(--kind serve-sim --base "$BASE")
  # The preview UI picks AVCC when WebCodecs is available; ?codec=mjpeg forces JPEG.
  if [ -n "${BROWSER:-}" ]; then
    QUERY=""; if [ "$codec" = mjpeg ]; then QUERY="?codec=mjpeg"; fi
    KIND_ARGS=(--kind browser --base "http://127.0.0.1:$PORT/$QUERY")
  fi
  bun "$HERE/bench-stream.ts" --udid "$UDID" --label "$LABEL-$codec${BROWSER:+-browser}" --codec "$codec" \
    "${KIND_ARGS[@]}" --ws "$WS" --port "$(echo "$BASE" | sed -E 's#.*:([0-9]+).*#\1#')" \
    ${BENCH_ARGS:-} --out "$OUTDIR/$LABEL-$codec${BROWSER:+-browser}${SUFFIX:-}.json" \
    | bun -e 'const d=JSON.parse(await Bun.stdin.text());console.log(d.label,"lat p50/p95",d.latency.clientMs.p50,d.latency.clientMs.p95,"overhead p50",d.latency.overheadMs.p50,"fps",d.anim.clientFps,"/",d.anim.sourceFps,"B/f",d.anim.bytesPerFrame,"cpu",d.cpu.animPct,"miss",d.latency.missed)'
done
