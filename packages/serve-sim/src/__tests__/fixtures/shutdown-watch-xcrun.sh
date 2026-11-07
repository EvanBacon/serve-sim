#!/bin/sh
set -eu

case "$*" in
  "simctl list devices booted -j")
    printf started > "$SERVE_SIM_TEST_QUERY_DIR/query-started"
    while [ ! -e "$SERVE_SIM_TEST_QUERY_DIR/release-query" ]; do
      sleep 0.02
    done
    printf finished > "$SERVE_SIM_TEST_QUERY_DIR/query-finished"
    ;;
  "simctl list devices -j") ;;
  *)
    printf 'Refusing unexpected simulator command: %s\n' "$*" >&2
    exit 88
    ;;
esac

printf '{"devices":{"test":[{"udid":"%s","state":"Booted"}]}}\n' "$SERVE_SIM_TEST_UDID"
