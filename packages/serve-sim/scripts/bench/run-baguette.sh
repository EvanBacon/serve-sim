#!/usr/bin/env bash
# Benchmark tddworks/baguette with the same scenarios as bench-suite.sh.
#   run-baguette.sh <baguette binary> <port> <outdir>
set -uo pipefail
BIN=$1; PORT=$2; OUTDIR=$3
UDID=${UDID:?set UDID to the simulator to benchmark}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUTDIR"
"$BIN" serve --port "$PORT" --no-plugins >"$OUTDIR/baguette.server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/simulators.json" >/dev/null && break; sleep 0.5; done
run() { # <format> <suffix> <args...>
  local fmt=$1 sfx=$2; shift 2
  bun "$HERE/bench-stream.ts" --udid "$UDID" --kind baguette --label "baguette-$fmt" --port "$PORT" \
    --base "ws://127.0.0.1:$PORT/simulators/$UDID/stream?format=$fmt" "$@" --out "$OUTDIR/baguette-$fmt$sfx.json" \
    | bun -e 'const d=JSON.parse(await Bun.stdin.text());console.log(d.label,"lat p50/p95",d.latency.clientMs.p50,d.latency.clientMs.p95,"overhead p50",d.latency.overheadMs.p50,"fps",d.anim.clientFps,"/",d.anim.sourceFps,"B/f",d.anim.bytesPerFrame,"cpu",d.cpu.animPct,"miss",d.latency.missed)'
}
for fmt in avcc mjpeg; do run $fmt -ui --trials ${TRIALS:-20} --flip square --anim scroll; done
for fmt in avcc mjpeg; do run $fmt -noise --trials ${TRIALS:-20} --flip noise --anim noise; done
run avcc -tap --trials ${TRIALS:-20} --flip square --anim scroll --stimulus tap
