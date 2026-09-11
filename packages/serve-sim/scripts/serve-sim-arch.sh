#!/bin/bash
# Architecture flags for camera injector/helper, ax-settings, and SimNative.
# Sourced by Sources/*/build.sh. Default is universal so local/npm builds stay
# fat; CI test jobs export SERVE_SIM_ARCH=arm64.
#
# Usage (sourced):
#   source "$HERE/../../scripts/serve-sim-arch.sh"
#   serve_sim_resolve_arch
#   clang ... "${SERVE_SIM_CLANG_ARCH_FLAGS[@]}"
#   swift build "${SERVE_SIM_SWIFT_ARCH_FLAGS[@]}"
#
# Usage (cli, for tests):
#   SERVE_SIM_ARCH=arm64 ./serve-sim-arch.sh clang|swift|resolved

serve_sim_resolve_arch() {
  local raw="${SERVE_SIM_ARCH:-universal}"
  case "$raw" in
    arm64|x86_64|universal) ;;
    *)
      echo "error: SERVE_SIM_ARCH must be arm64, x86_64, or universal (got: $raw)" >&2
      return 1
      ;;
  esac
  SERVE_SIM_ARCH_RESOLVED="$raw"
  case "$raw" in
    arm64)
      SERVE_SIM_CLANG_ARCH_FLAGS=(-arch arm64)
      SERVE_SIM_SWIFT_ARCH_FLAGS=(--arch arm64)
      ;;
    x86_64)
      SERVE_SIM_CLANG_ARCH_FLAGS=(-arch x86_64)
      SERVE_SIM_SWIFT_ARCH_FLAGS=(--arch x86_64)
      ;;
    universal)
      SERVE_SIM_CLANG_ARCH_FLAGS=(-arch arm64 -arch x86_64)
      SERVE_SIM_SWIFT_ARCH_FLAGS=(--arch arm64 --arch x86_64)
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  serve_sim_resolve_arch
  case "${1:-clang}" in
    clang) printf '%s\n' "${SERVE_SIM_CLANG_ARCH_FLAGS[@]}" ;;
    swift) printf '%s\n' "${SERVE_SIM_SWIFT_ARCH_FLAGS[@]}" ;;
    resolved) printf '%s\n' "$SERVE_SIM_ARCH_RESOLVED" ;;
    *)
      echo "usage: $0 [clang|swift|resolved]" >&2
      exit 2
      ;;
  esac
fi
