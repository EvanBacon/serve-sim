---
name: serve-sim
description: Control and stream a running iOS, iPad, or Apple Watch Simulator with npx serve-sim. Use for simulator preview, accessibility refs (ax --refs, tap @eN --settle), taps, gestures, hardware buttons, rotation, camera injection, permissions, recording and the rolling buffer, the persistent control process, repair-input, and CoreAnimation debug.
license: Apache-2.0
---

# serve-sim

Drive an Apple Simulator (iOS, iPad, Apple Watch) from an agent using the [serve-sim](https://github.com/EvanBacon/serve-sim) CLI. serve-sim spawns a Swift helper that captures the simulator framebuffer via `simctl io`, exposes it as an MJPEG stream plus a binary WebSocket input channel, and serves a React preview UI on top. This skill teaches an agent the exact CLI surface, the gesture JSON shape, the gotchas, and the recommended workflows.

## When to use

- The user wants an agent to **tap, swipe, drag, pinch, or send hardware buttons** to a running Apple Simulator.
- The user wants to **stream a simulator** to a browser (local, LAN, or tunneled) for review or remote control.
- The user wants to **inject a synthetic camera feed** (file, webcam, or animated placeholder) into a specific app on the simulator.
- The user wants to **toggle CoreAnimation debug overlays** (off-screen rendering, blended layers, slow animations) for performance work.
- The user wants to **simulate a memory warning** or **rotate the device** programmatically.
- The user wants to **read the simulator's accessibility tree** to find UI elements without pixel hunting.
- The user wants to **grant, revoke, or reset an app's privacy permissions** — camera, photos, location, contacts, or **push notifications**.
- The user wants to **record the screen or inspect what just happened** (`serve-sim record` / `buffer`) without opening a video by hand.
- Taps or typing have **stopped working** and serve-sim or `doctor` pointed at `repair-input`.

## When NOT to use

- Android emulators → use `adb shell` tooling.
- Building or installing an iOS app → use `xcodebuild` or `xcrun simctl install`.
- React Native in-app runtime debugging (Redux state, network inspection, component tree) → use rn-debugger tooling.
- Real iOS hardware devices → use `xcrun devicectl` or Xcode.

## Prerequisites

Before any other action, verify the host satisfies these. If something is missing, tell the user exactly what to install — do not proceed.

| Requirement | Check command | Why |
|---|---|---|
| macOS host | `uname -s` returns `Darwin` | serve-sim only runs on macOS |
| Xcode CLI tools | `xcrun --version` exits 0 | `simctl` is the underlying simulator driver |
| Node.js ≥20 | `node --version` ≥20 | serve-sim is an npm package run via `npx` |
| macOS 14+ (optional) | `sw_vers -productVersion` ≥14 | Required ONLY for `camera` subcommand |

A bundled helper script is available: `scripts/check-prereqs.sh`. Run it; if it exits non-zero, surface the message to the user.

A booted simulator is required for most subcommands. Check with `xcrun simctl list devices booted`. If none are booted, tell the user to open Xcode → Simulator or to run `xcrun simctl boot <UDID>`.

## Mental model

```text
┌──────────────┐  simctl io  ┌─────────────────┐  MJPEG / WS  ┌─────────┐
│ iOS Simulator│ ──────────► │ serve-sim-bin   │ ───────────► │ Browser │
└──────────────┘   (Swift)   │ (per-device)    │              └─────────┘
                             └─────────────────┘
                                     ▲
                              state file in
                            $TMPDIR/serve-sim/
                                     ▲
                            ┌──────────────────┐
                            │ serve-sim CLI    │
                            └──────────────────┘
```

Key invariants the agent must respect:

- **All coordinates are normalized 0..1**, with `(0, 0)` at top-left and `(1, 1)` at bottom-right of the display. Never pass pixel coordinates.
- **One helper per device**. Multiple booted simulators are supported by passing several device names or by attaching to all.
- **State lives in `$TMPDIR/serve-sim/server-{udid}.json`**. Use `serve-sim --list` to query it; do not read the JSON directly unless you know what you are doing.
- **The orientation set via `rotate` is remembered by the helper**, and subsequent gestures are rotated client-side. An agent that sends raw coords after a rotation does not need to compensate manually.

## Common operations

| Goal | Command | Notes |
|---|---|---|
| Start preview server | `npx serve-sim [device]` | Default preview at `http://localhost:3200`, stream at `:3100`. Foreground process. |
| Start headless / daemon | `npx serve-sim --detach [device]` | Returns JSON with `pid`, `port`, `url`. Use for agent loops. |
| Show stream in host's preview | `npx serve-sim --detach -q` → hand off `url` to host preview tool | See "Showing the stream in your agent's preview" section. |
| List running streams | `npx serve-sim --list` | Add `-q` for JSON-only output. |
| Stop all helpers | `npx serve-sim --kill` | Pass `[device]` to stop a specific one. |
| Single tap | `npx serve-sim tap <x> <y>` | `<x> <y>` in `0..1`. **Use this, not `gesture`, for plain taps.** See "Critical gotcha" below. |
| Multi-step gesture | `npx serve-sim gesture '<json>'` | See [references/gestures.md](references/gestures.md). |
| Hardware button | `npx serve-sim button <name>` | Names: `home`, `swipe_home`, `app_switcher`, `lock`, `siri`, `side_button`. See [references/buttons-rotation.md](references/buttons-rotation.md). |
| Rotate device | `npx serve-sim rotate <orientation>` | `portrait`, `portrait_upside_down`, `landscape_left`, `landscape_right`. |
| Simulate memory warning | `npx serve-sim memory-warning` | Equivalent to Debug → Simulate Memory Warning. |
| CoreAnimation debug | `npx serve-sim ca-debug <option> <on\|off>` | Options: `blended`, `copies`, `misaligned`, `offscreen`, `slow-animations`. See [references/ca-debug.md](references/ca-debug.md). |
| Inject camera feed | `npx serve-sim camera <bundle-id> [--file <path>\|--webcam [name]]` | (Re)launches the app with the camera dylib attached. macOS 14+ only. See [references/camera.md](references/camera.md). |
| Hot-swap camera source | `npx serve-sim camera switch <placeholder\|webcam\|file> [arg]` | No app relaunch. |
| Manage app permissions | `npx serve-sim permissions <grant\|revoke\|reset\|list> <permission> <bundle-id>` | Camera, photos, location, **push notifications**, contacts, etc. See [references/permissions.md](references/permissions.md). |
| Compact AX snapshot | `npx serve-sim ax --refs` | Visible elements with `@eN` refs. Prefer this over raw `GET /ax` plus frame math. See [references/agent-guide.md](references/agent-guide.md). |
| Tap an element ref | `npx serve-sim tap @e2 [--settle]` | Resolves the last snapshot; refuses stale/unknown/offscreen refs instead of guessing. |
| Wait for the screen to settle | `npx serve-sim settle [--timeout ms]` | Diff vs the last state you were shown. |
| Repair Device Hub input | `npx serve-sim repair-input [-d udid]` | **Explicit only.** Restarts SpringBoard and closes running apps. Then restart serve-sim and reopen the app. |
| Control process | `npx serve-sim control [status\|start\|stop]` | Optional. Short commands auto-start a warm daemon; you usually do not need to manage it. |
| Record / inspect | `npx serve-sim record` / `record frame` / `diff` / `changes` | MP4 plus an index sidecar. Offline inspection needs no server. |
| Rolling buffer | `npx serve-sim buffer start` then `list` / `frame` | Opt-in recent frames + input. Off by default. |
| Raw accessibility tree | `curl <streamUrl>/ax` | axe-style JSON. Discover `streamUrl` with `--list -q`; do not hardcode :3100. See [references/endpoints.md](references/endpoints.md). |

Most subcommands accept `-d <udid|name>` to target a specific device when several are booted.

## Critical gotcha: prefer `tap` over `gesture` for taps

Each `serve-sim gesture` call opens its own WebSocket. If you issue two back-to-back `gesture` calls — one with `{"type":"begin",...}` and one with `{"type":"end",...}` — the simulator receives them with enough latency between them that the touch is interpreted as a **long-press**, not a tap. This is a deliberate constraint of the protocol, not a bug to work around.

**Rule**: for any single-shot tap, use `serve-sim tap <x> <y>`. Only use `gesture` for drags, swipes, or multi-step interactions where you must thread the same socket across `begin` → `move` × N → `end`.

## Targeting a specific device

When multiple simulators are booted, every subcommand accepts `-d <udid|name>`. The name match is case-insensitive against the device name returned by `xcrun simctl list devices booted`. Examples:

```sh
npx serve-sim tap 0.5 0.5 -d "iPhone 16 Pro"
npx serve-sim button home -d ABC12345-...
npx serve-sim --list                                # show all running streams
```

If the user has only one booted simulator, omit `-d` entirely. The skill should prefer auto-detection over hard-coding device names.

## Output modes

By default, serve-sim prints human-readable status to stdout. For agent loops, prefer JSON output:

```sh
npx serve-sim --list -q          # JSON array of running streams
npx serve-sim --detach -q        # JSON with pid/port/url after spawn
npx serve-sim camera status -q   # JSON with {alive, source, mirror, ...}
```

Parse `-q` output programmatically. Never parse the non-`-q` human output — it can change between versions.

## Showing the stream in your agent's preview

When the user asks to "see the simulator here", "view it in preview", "open it in this tool", or similar, the goal is to stream the simulator into the same surface the user is chatting with. serve-sim returns a regular HTTP URL — the agent's job is to surface that URL and, if the host exposes a preview tool, hand it off.

Steps:

1. Start serve-sim and capture the URL:
   ```sh
   npx serve-sim --detach -q
   ```
   This returns JSON like `{"pid":..., "port":3200, "url":"http://localhost:3200", "streamUrl":"http://localhost:3100", ...}`. The `url` field is the human-facing preview UI; `streamUrl` is the raw MJPEG endpoint.

2. **Always surface the URL plainly** in your response so the user can fallback to opening it manually in any browser.

3. **Probe your host's preview tool** and hand off the URL if one exists. Examples of tool names you may see in your toolset:
   - `preview_start` (Claude Code) — call it with `{ url: "<url>" }`.
   - `mcp__Claude_Preview__preview_start` (some MCP setups).
   - A `browser_open`, `open_url`, or similar URL-opening tool — pass the URL.
   - Cursor / Codex CLI / others may not expose a preview tool to the agent. In that case, just print the URL and tell the user how to open it (their browser, their IDE's built-in browser pane, etc.).

4. **Do not assume any specific preview tool exists.** Inspect the tools available to you in the current session. If one matches the description above, use it. If none does, fall back to step 2 (print the URL prominently).

The stream stays alive until `npx serve-sim --kill`. Multiple clients (the host's preview + the user's browser + a tunnel) can read the same URL simultaneously.

See [references/workflows.md](references/workflows.md) workflow "Show the simulator stream in the host's preview" for the full recipe.

## Workflows

The agent playbook (attach vs. start, refs, the control process, `repair-input`, recording and the buffer, delivery failures) is [references/agent-guide.md](references/agent-guide.md). End-to-end recipes (UI automation, camera testing, deep-link flows, preview handoff) are in [references/workflows.md](references/workflows.md).

## Cleanup

Always stop helpers when finished, unless the user explicitly wants them to keep running:

```sh
npx serve-sim --kill            # stop all
npx serve-sim --kill "iPhone 16 Pro"  # stop one
```

Helpers occupy the ports they were started on (3200/3100 only if those defaults were free). Do not kill a helper you did not start.

## Anti-patterns

- **Do not pass pixel coordinates.** All coords are normalized `0..1`. If the user gives pixel values, divide by the screen dimensions reported by `GET /config`.
- **Do not use `gesture` for plain taps.** Use `tap`. See "Critical gotcha" above.
- **Do not assume `npx serve-sim` is already running.** Verify with `--list` or by checking `$TMPDIR/serve-sim/server-{udid}.json`. If absent, start it explicitly.
- **Do not skip the prerequisites check** on the first invocation in a session. Wrong macOS version, missing Xcode CLI tools, or Node <18 produce confusing errors downstream.
- **Do not invent button names.** Only these six are valid: `home`, `swipe_home`, `app_switcher`, `lock`, `siri`, `side_button`. See [references/buttons-rotation.md](references/buttons-rotation.md) for the source-of-truth list.
- **Do not parse the non-quiet human output.** Use `-q` for JSON.
- **Do not leave camera helpers running** across unrelated tasks. Stop them with `npx serve-sim camera --stop-webcam` when done.
- **Do not guess coordinates when an accessibility lookup returns no match.** Prefer `serve-sim ax --refs` and `tap @eN`. If the ref is stale, unknown, or offscreen, or a raw `GET /ax` query missed, fail loudly and re-snapshot — tapping a guessed spot is almost always worse than reporting "target not found." See [references/agent-guide.md](references/agent-guide.md) and [references/workflows.md](references/workflows.md) workflow 1.
- **Do not run `repair-input` unless the error or `doctor` says Device Hub has disconnected legacy input.** It restarts SpringBoard and closes running apps. A tap that failed because the simulator is not Booted (`could not deliver the tap`) is a different failure; boot the sim instead.
- **Do not start a second preview on port 3200, or `--kill` an existing one, when someone is already using it.** `--list -q` first; attach with `-d` / `--url`, or start on a free `--port`.

## Reference index

- [references/agent-guide.md](references/agent-guide.md) — agent playbook: attach, refs, control process, `repair-input`, recording/buffer, delivery failures.
- [references/gestures.md](references/gestures.md) — exact gesture JSON shapes, edge values, multi-touch, drag/swipe recipes.
- [references/buttons-rotation.md](references/buttons-rotation.md) — the six valid buttons and the four orientations, with behavioral notes.
- [references/camera.md](references/camera.md) — synthetic camera injection: placeholder, file, webcam, mirror modes, hot-swap.
- [references/permissions.md](references/permissions.md) — granting/revoking app privacy permissions, including push notifications.
- [references/ca-debug.md](references/ca-debug.md) — the five CoreAnimation debug flags and when each one helps.
- [references/endpoints.md](references/endpoints.md) — HTTP and WebSocket endpoints for agents that bypass the CLI.
- [references/workflows.md](references/workflows.md) — end-to-end recipes for UI automation, camera testing, deep-link flows.
