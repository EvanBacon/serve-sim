# Gestures reference

## Contents

- Coordinate system
- Single-touch JSON shape
- Multi-touch JSON shape
- Edge values (system edge gestures)
- Common recipes (swipe, drag, pinch)
- Why `tap` is preferred over `gesture` for taps

## Coordinate system

All coordinates are normalized floats in `[0, 1]`:

- `(0.0, 0.0)` = top-left of the display
- `(1.0, 1.0)` = bottom-right of the display
- `(0.5, 0.5)` = center

The web viewer and the `tap` / `gesture` CLI compensate for device orientation automatically. After a `rotate landscape_left`, coords still describe the **logical** display from the user's perspective (e.g. as seen in a landscape screenshot) — you do not rotate them manually. Both fingers of a multi-touch step and `edge` values are remapped too. Pass `--raw` to send native portrait coordinates unmapped.

To convert pixel coords to normalized, divide by the display dimensions reported by `GET <streamUrl>/config` (`{width, height, orientation}`; find `streamUrl` with `npx serve-sim --list -q`).

## Single-touch JSON shape

```json
{
  "type": "begin",
  "x": 0.5,
  "y": 0.5,
  "edge": 0
}
```

| Field | Type | Required | Values |
|---|---|---|---|
| `type` | string | yes | `"begin"`, `"move"`, `"end"` |
| `x` | number | yes | `0.0`–`1.0` |
| `y` | number | yes | `0.0`–`1.0` |
| `edge` | integer | no | `0`–`4` (see below) |

A complete touch is a sequence of `begin` → 0 or more `move` → `end`. It must fit inside a single `gesture` call: pass a JSON **array** of steps (see the recipes below). Split across calls, the finger stays down between them, and a realistic gap between invocations makes the `begin` read as a long-press.

Each step may also carry `delayMs` (non-negative number): how long to wait after sending it before the next step, default `16` (~one 60fps frame). It is CLI-only and is not sent to the simulator.

Invalid input fails before anything is sent: the CLI prints the problem (naming `step N/M` for arrays) to stderr and exits 1. If the server reports a step was not delivered, the CLI also exits 1.

## Multi-touch JSON shape

```json
{
  "type": "begin",
  "x1": 0.4,
  "y1": 0.5,
  "x2": 0.6,
  "y2": 0.5
}
```

| Field | Type | Required | Values |
|---|---|---|---|
| `type` | string | yes | `"begin"`, `"move"`, `"end"` |
| `x1`, `y1` | number | yes | first finger, `0.0`–`1.0` |
| `x2`, `y2` | number | yes | second finger, `0.0`–`1.0` |

Multi-touch does not support `edge` (a multi-touch step with `edge` is rejected). A step must use one shape: mixing `x`/`y` with any of `x1`/`y1`/`x2`/`y2` is rejected. Steps of both shapes may appear in the same array. Use multi-touch for pinch, zoom, and two-finger rotation gestures.

## Edge values

The `edge` field flags a touch as a system edge gesture. iOS interprets edge touches specially (e.g., bottom edge swipe = swipe-to-home on Face ID devices). Values:

| Value | Edge | Effect |
|---|---|---|
| `0` | none | Regular touch (default; omit `edge` entirely) |
| `1` | left | Left-edge swipe (back gesture in many apps) |
| `2` | top | Top-edge pull (Notification Center / Control Center) |
| `3` | bottom | Bottom-edge swipe (swipe-to-home on Face ID devices) |
| `4` | right | Right-edge swipe |

For a swipe-to-home on a Face ID device, you can use `npx serve-sim button swipe_home` — it issues the correct edge-3 touch sequence for you.

## Common recipes

### Tap (avoid `gesture` — use `tap`)

```sh
npx serve-sim tap 0.5 0.5
```

Two separate `gesture` calls for `begin` and `end` will usually be interpreted as a long-press, because the finger stays down for the whole gap between the calls. Always use `tap`.

### Drag (vertical scroll down)

Pass the whole sequence as a JSON **array** in ONE `gesture` call — the CLI sends every step in order, waiting `delayMs` (default 16ms, ~one 60fps frame) after each step.

For a **positional drag** (content follows the finger and stops where you let go), use many small moves (~10–20) and hold ~300ms on the last move (its `delayMs`) before `end`:

```sh
# scroll DOWN by ~half a screen = drag the finger UP from y=0.8 to y=0.4
npx serve-sim gesture "$(python3 -c '
import json
steps = [{"type": "begin", "x": 0.5, "y": 0.8}]
steps += [{"type": "move", "x": 0.5, "y": round(0.8 - 0.4 * i / 20, 3)} for i in range(1, 21)]
steps[-1]["delayMs"] = 300  # hold before lifting so it does not fling
steps.append({"type": "end", "x": 0.5, "y": 0.4})
print(json.dumps(steps))
')"
```

For a **momentum flick**, use a few large, fast moves and no hold:

```sh
npx serve-sim gesture '[
  {"type":"begin","x":0.5,"y":0.8},
  {"type":"move","x":0.5,"y":0.65},
  {"type":"move","x":0.5,"y":0.5},
  {"type":"move","x":0.5,"y":0.35},
  {"type":"end","x":0.5,"y":0.35}
]'
```

A short hold is not enough: a few fast moves with `delayMs: 80` on the last one still flings. Do NOT split the sequence across multiple `gesture` calls — the finger stays down between calls, and with any realistic gap between them (e.g. separate agent tool calls) the held `begin` registers as a long-press (in a webview it triggers text selection) instead of a scroll.

### Pinch to zoom in

```sh
npx serve-sim gesture '[
  {"type":"begin","x1":0.4,"y1":0.5,"x2":0.6,"y2":0.5},
  {"type":"move","x1":0.25,"y1":0.5,"x2":0.75,"y2":0.5},
  {"type":"end","x1":0.25,"y1":0.5,"x2":0.75,"y2":0.5}
]'
```

### Pull down Notification Center (top edge)

Start at the very top edge and travel down in ~20 small moves (here 0.03 each, 16ms apart), with `edge` 2 on every step:

```sh
npx serve-sim gesture "$(python3 -c '
import json
steps = [{"type": "begin", "x": 0.5, "y": 0.005, "edge": 2}]
steps += [{"type": "move", "x": 0.5, "y": round(0.005 + 0.03 * i, 3), "edge": 2} for i in range(1, 21)]
steps.append({"type": "end", "x": 0.5, "y": 0.605, "edge": 2})
print(json.dumps(steps))
')"
```

A single large move (`begin` + 1 move + `end`) does not open Notification Center.

### Swipe back from left edge

Start at the very left edge and travel across in ~20 small moves (here 0.04 each, 16ms apart):

```sh
npx serve-sim gesture "$(python3 -c '
import json
steps = [{"type": "begin", "x": 0.01, "y": 0.5}]
steps += [{"type": "move", "x": round(0.01 + 0.04 * i, 2), "y": 0.5} for i in range(1, 21)]
steps.append({"type": "end", "x": 0.81, "y": 0.5})
print(json.dumps(steps))
')"
```

Too few large moves (e.g. `begin` + 2–3 moves + `end`) do not trigger the back gesture.

## Why `tap` is preferred

When you issue `begin` and `end` as two separate `gesture` calls, the finger stays down for the whole gap between the invocations. iOS measures how long a touch is held, and the gap between separate calls (especially separate agent tool calls) is long enough for the touch to read as a long-press, not a tap.

The `tap` subcommand exists specifically to avoid this: it issues `begin` and `end` together in one invocation with negligible delay, producing a true tap every time. There is no good reason to emulate a tap with `gesture`.
