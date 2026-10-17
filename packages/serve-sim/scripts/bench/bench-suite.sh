#!/usr/bin/env bash
# Run the standard scenario matrix for one serve-sim build.
#   bench-suite.sh <label> <port> <outdir> <serve-sim command...>
# Scenarios:
#   ui    — small centre-square flip latency + scrolling-text animation (typical UI)
#   noise — full-screen noise flip latency + noise animation (encoder stress)
#   tap   — tap through serve-sim's HID WebSocket → page repaint (input-to-photon)
set -uo pipefail
LABEL=$1; PORT=$2; OUTDIR=$3; shift 3
HERE=$(cd "$(dirname "$0")" && pwd)
CODECS=${CODECS:-"avcc mjpeg"} SUFFIX=-ui BENCH_ARGS="--trials ${TRIALS:-20} --flip square --anim scroll" "$HERE/run-target.sh" "$LABEL" "$PORT" "$OUTDIR" "$@"
CODECS=${CODECS:-"avcc mjpeg"} SUFFIX=-noise BENCH_ARGS="--trials ${TRIALS:-20} --flip noise --anim noise" "$HERE/run-target.sh" "$LABEL" "$PORT" "$OUTDIR" "$@"
CODECS=${TAP_CODECS:-avcc} SUFFIX=-tap BENCH_ARGS="--trials ${TRIALS:-20} --flip square --anim scroll --stimulus tap" "$HERE/run-target.sh" "$LABEL" "$PORT" "$OUTDIR" "$@"
