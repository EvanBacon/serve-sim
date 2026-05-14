#!/usr/bin/env bash
# Verify the host satisfies serve-sim's prerequisites.
# Exits 0 if everything is OK, 1 with a human message otherwise.
# Intended to be sourced by an agent before any other serve-sim command.

set -u

fail() {
  echo "serve-sim prereq check failed: $1" >&2
  exit 1
}

# macOS host
if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "serve-sim requires macOS. Detected: $(uname -s)."
fi

# Xcode CLI tools (simctl)
if ! command -v xcrun >/dev/null 2>&1; then
  fail "xcrun not found. Install Xcode command line tools: xcode-select --install"
fi
if ! xcrun --find simctl >/dev/null 2>&1; then
  fail "simctl not found via xcrun. Install Xcode command line tools."
fi

# Node 18+
if ! command -v node >/dev/null 2>&1; then
  fail "node not found. Install Node.js 18 or newer (https://nodejs.org)."
fi
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "node $NODE_MAJOR detected. serve-sim requires Node.js 18+."
fi

# macOS 14+ is optional (camera-only), so warn rather than fail
MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [[ "$MACOS_MAJOR" -lt 14 ]]; then
  echo "warning: macOS $(sw_vers -productVersion) detected. The 'camera' subcommand requires macOS 14+." >&2
fi

# A booted simulator is required for most commands
if ! xcrun simctl list devices booted 2>/dev/null | grep -q "Booted"; then
  echo "warning: no booted simulator detected. Boot one with Xcode > Simulator or 'xcrun simctl boot <UDID>'." >&2
fi

echo "serve-sim prereqs OK."
exit 0
