# Agent guide

How to drive an Apple Simulator with serve-sim. The [package README](../../../packages/serve-sim/README.md) is the full CLI contract; this page is the agent loop: attach, act, check, recover. Contributor notes for working on this repo live in the root [`AGENTS.md`](../../../AGENTS.md).

## Attach, don't steal

1. Confirm the host is macOS with Xcode's `simctl` and Node.js 20+.
2. See what is already running:

```sh
xcrun simctl list devices booted
serve-sim --list -q
```

3. If a serve-sim server is already running for the device you need, use it. Pass `-d <udid|name>` when more than one simulator is booted, and `--url` / `SERVE_SIM_URL` (plus `--auth-token` / `SERVE_SIM_AUTH_TOKEN` when the preview requires it) instead of starting another server.
4. If you must start a server, use `--detach -q` and pick a **free** `--port`. Do not assume 3200 or 3100 are yours: those are only the defaults, and a person may already be previewing there. Print the returned `url` so they can open it.
5. Do not `serve-sim --kill` a helper you did not start, unless the user asked you to stop it.

Most subcommands also accept `-q` for JSON. Parse that, not the human-readable output.

## Persistent control process

Short commands used to pay a full Node + bundle startup on every call (about 66–113 ms). The `serve-sim` bin is a small entry that hands those commands to a background control process with warm workers already loaded.

- **Automatic.** The first short command starts the process and runs in-process itself. Later calls are faster (on one Apple Silicon Mac, warm `--help` dropped from 66.2 ms to 31.9 ms p50, and a live `tap` from 113.3 ms to 84.8 ms). It idle-exits after 5 minutes (`SERVE_SIM_CONTROL_IDLE_MS`).
- **Which commands:** `tap`, `gesture`, `settle`, `button`, `type`, `paste`, `rotate`, `fold`, `ca-debug`, `memory-warning`, `event-log`, `ax`, `buffer`, and bare `--help` / `--version`. The preview server, `--detach`, `record`, `camera`, `exec`, `doctor`, `permissions`, `ui`, and anything with `--stdin` still run in-process.
- **You usually do not have to manage it.** If you do:

```sh
serve-sim control status [--json]   # exit 1 when not running
serve-sim control start             # idempotent
serve-sim control stop              # idempotent; clears stale socket/pid files
```

- **Sandboxes.** Known agent sandboxes (`CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, Claude Code's `SANDBOX_RUNTIME`) never start or use a daemon, so one cannot be born inside a sandbox or used to leave it. Other sandboxes are not detected: set `SERVE_SIM_CONTROL=0` under them. `SERVE_SIM_CONTROL=0` also disables it anywhere. Under `CI` it is only used if already running, unless you set `SERVE_SIM_CONTROL=1`.

If the control process is missing, stale, or does not accept a command in time, that call runs in-process and nothing has executed yet. Once a call has been accepted, a lost connection fails that call (exit 1) instead of running the command twice. Details and the measured table are in the README's "Control process" section.

## Drive the UI with refs

Prefer element refs over pixel hunting:

```sh
serve-sim ax --refs                 # compact snapshot; each node has @eN, role, label, frame
serve-sim tap @e2 --settle          # tap that element's current center, wait, print the diff
serve-sim settle                    # after openurl or any other action: wait, diff vs the last state you were shown
```

`--all` includes offscreen elements; `--text` prints one line per element. The server remembers the last snapshot per device. Before tapping it looks the element up in the live tree and taps it where it is now.

If the ref is unknown, stale, or offscreen, the command exits 1 (`unknown_ref` / `stale_ref` / `offscreen` on stderr) and **nothing is tapped**. Take a new snapshot and retry. Never guess a coordinate because a lookup missed.

Use `serve-sim tap <x> <y>` only when there is no accessibility target (a game canvas, a raw screenshot point). Coordinates are normalized 0..1, origin top-left. Prefer `tap` over `gesture` for a single-shot tap: two separate `gesture` begin/end calls open two WebSockets and often register as a long-press. Use `gesture` only for a drag or a multi-step sequence that must share one socket.

`--timeout` (default 3000 ms, max 30000) is a hard limit on settle. `settled: false` with `reason: "timeout"` still returns the current tree and exits 0. After a reboot, a SpringBoard restart, or an app relaunch, take a fresh `ax --refs` — old refs do not survive that.

HTTP equivalents, busy/429 behavior, and the identity rules that decide when a ref carries over are in the README's "Accessibility refs for agents" section and in [endpoints.md](endpoints.md).

## When input fails

These are different failures. Do not treat them as the same, and do not retry as if the input landed.

**Device Hub has disconnected legacy input.** Touch and keyboard (not Home) are refused, and the error tells you to run `serve-sim repair-input -d <udid>`. That command is **explicit, never automatic**: it restarts SpringBoard and closes running apps. After a successful repair, restart serve-sim so it can reconnect guest HID services, then reopen the app and take a new snapshot. If it prints `Input is not shadowed by Device Hub; no restart needed.`, stop — do not repair in a loop. `serve-sim doctor` can also recommend this.

**The simulator is not Booted, or HID could not send.** `tap`, `button`, and `gesture` exit 1 with `could not deliver the tap` (or button/gesture). That means the input was not handed to a booted guest — for example after `simctl shutdown` — not that it landed. Boot the simulator, wait until it is Booted, and retry. Right after boot, input can be withheld until the HID client is ready; a refused or failed call is not a delivered one. `no delivery confirmation within 4s` is also not success: the ack never arrived (the injector may have been stuck). Check the server log, and restart the serve-sim server for that device if you started it.

**The server is gone.** A closed or failed WebSocket means you are not talking to a running helper. `serve-sim --list -q`, then start or restart only a server you are responsible for.

## Look back without guessing

To see what a tap or a crash just did, do not start from a still screenshot unless you have to.

- **`serve-sim buffer`** is an opt-in rolling window of recent small JPEG frames plus nearby input (off by default; nothing extra runs while off). `buffer start`, act, then `buffer list --since 5` and `buffer frame --ago 2`. `buffer stop` when you are done.
- **`serve-sim record`** writes an MP4 and, unless you pass `--no-index`, a `<name>.index.jsonl` sidecar. Afterward, with no server required: `record frame <mp4> -t <s>`, `record diff <mp4> --from <s> --to <s>`, and `record changes <mp4> --from <s> --to <s>`.

The README's "Rolling buffer" and "Screen recording" sections cover options, HTTP, and limits.

## Cleanup

Stop helpers **you** started when the task is done, unless the user wants them left up:

```sh
serve-sim --kill <udid-or-name>     # the helper you started
serve-sim camera --stop-webcam      # if you injected a camera
serve-sim buffer stop               # if you started the buffer
# serve-sim control stop            # only if you need the daemon gone; otherwise it idle-exits
```

## Anti-patterns

- Do not pass pixel coordinates. If you are given pixels, divide by `GET /config` (or the snapshot's `screen`) to normalize.
- Do not use `gesture` for a plain tap.
- Do not guess a tap target when `ax --refs` or `/ax` has no match, and do not invent button names. Valid buttons: `home`, `swipe_home`, `app_switcher`, `lock`, `siri`, `side_button`.
- Do not run `repair-input` prophylactically, in a loop, or because a tap failed after shutdown. Only run it when the error (or `doctor`) says Device Hub has disconnected legacy input, and warn that it restarts SpringBoard.
- Do not start a second preview on port 3200, or kill a preview, when someone is already using one.
- Do not parse non-`-q` human output, and do not skip the first-session prerequisites check.
- Do not look for a scrub timeline in the preview. Recordings are inspected with `record frame` / `diff` / `changes` (and the rolling buffer), not a timeline UI.

## Reference index

- [SKILL.md](../SKILL.md) — skill entry: when to use, common operations, preview handoff.
- [workflows.md](workflows.md) — end-to-end recipes.
- [endpoints.md](endpoints.md) — HTTP and WebSocket surfaces, including `/ax/snapshot`, `/ax/act`, `/ax/settle`.
- [gestures.md](gestures.md), [buttons-rotation.md](buttons-rotation.md), [camera.md](camera.md), [permissions.md](permissions.md), [ca-debug.md](ca-debug.md).
- [Package README](../../../packages/serve-sim/README.md) — control process, accessibility ref identity rules, recording index, rolling buffer, Duo / `repair-input`.
