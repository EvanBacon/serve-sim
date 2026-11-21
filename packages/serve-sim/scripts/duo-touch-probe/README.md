# Duo touch probe and harness

Measures iPhone Duo touch reliability against ground truth: what the app inside
the simulator actually received. Nothing here ships with serve-sim.

## Probe app (`dev.servesim.touchprobe`)

`TouchProbe.swift` is a one-window UIKit app. It appends one JSON line per touch
phase to `Documents/touches.jsonl` with:

- `x`/`y` in window points and `nx`/`ny` normalized to the window (display space)
- `fx`/`fy`: the same point in the screen's fixed coordinate space (the panel's
  raw native-portrait frame, which is what serve-sim sends on the wire)
- `display` (`cover`/`inner`, from the screen's native size), interface
  `orientation`, scene role, and `uptime`/`wall` timestamps

It also logs scene connect, geometry and active lines, so you can see which panel
the app is on.

```sh
packages/serve-sim/scripts/duo-touch-probe/build.sh <udid>   # swiftc + ad-hoc sign + install
xcrun simctl launch <udid> dev.servesim.touchprobe
cat "$(xcrun simctl get_app_container <udid> dev.servesim.touchprobe data)/Documents/touches.jsonl"
```

## Harness

Run against an already-running local server for one simulator. It never boots,
shuts down or repairs anything.

```sh
node packages/serve-sim/dist/serve-sim.js --port 3440 <udid>   # in another shell
bun packages/serve-sim/scripts/duo-touch-harness.ts --udid <udid> --port 3440 --out /tmp/duo-touch
#   [--suites grid,drag,rapid,after-pose,during-pose,toggle,rotate,long] [--poses closed,book,open] [--paths cli,ws]
bun packages/serve-sim/scripts/duo-touch-viewer.ts --udid <udid> --port 3440 --out /tmp/duo-touch-viewer [--rotate landscape_right]
```

For each pose, set over the WebSocket the same way the toolbar does, the harness
waits for the server's active panel and capture size to settle, then relaunches the
probe. It then sends:

| suite | what |
|---|---|
| grid | 3×5 taps (0.1/0.5/0.9 × 0.08…0.88) |
| drag | horizontal and vertical 12-step drags |
| rapid | 10 taps about 80 ms apart |
| rotate | `serve-sim rotate landscape_left`, a 3×3 grid and a drag, then back to portrait |
| after-pose | a tap 0–2500 ms after the pose **ack** |
| during-pose | a tap 0–1500 ms after **sending** a pose, without waiting for the ack (what a viewer user does) |
| toggle | 8 quick pose changes, then grids |
| long | about 3 minutes of mixed cli/ws grids |

Paths: `cli` spawns `dist/serve-sim.js tap|gesture` exactly as a user would; `ws`
sends the same `0x03` frames on one socket, with acks. The viewer script clicks the
real 3D viewer with agent-browser. It computes click pixels by forward-mapping a raw
target through the projection frame (`0x83`) the viewer uses.

Each shot is matched to the first probe `began` after it was sent. The report gives
sent / acked / delivered / right display / accurate (within 3% of the window) /
latency. CLI accuracy is judged in display space (its contract); ws and viewer
accuracy in raw panel space (theirs). Output: `<out>.json` and `<out>.md`.

Known non-serve-sim miss: the cover's top-right status-bar strip (beside the
camera cutout) keeps taps for the system.

Set `SERVE_SIM_TOUCH_TRACE=1` on the server to log one `[touch-trace]` line per
touch (server: route, panel, size, Device Hub state, result, time; native: Indigo
target or guest display, and channel outcome) to explain any miss.
