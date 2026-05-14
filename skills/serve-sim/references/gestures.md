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

The serve-sim client compensates for device orientation automatically. After a `rotate landscape_left`, coords still describe the **logical** display from the user's perspective — you do not rotate them manually.

To convert pixel coords to normalized, divide by the display dimensions reported by `GET http://localhost:3100/config` (`{width, height, orientation}`).

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

A complete touch is a sequence of `begin` → 0 or more `move` → `end` on the **same** WebSocket. The `gesture` CLI opens one socket per invocation, so a complete touch must fit inside a single CLI call's payload, or be issued via the WebSocket directly.

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

Multi-touch does not support `edge`. Use it for pinch, zoom, and two-finger rotation gestures.

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

Two back-to-back `gesture` calls for `begin` and `end` will be interpreted as a long-press because each call opens a fresh WebSocket. Always use `tap`.

### Drag (vertical scroll down)

A drag is a sequence on a single WebSocket. With the CLI, the simplest correct approach is the streaming server's WebSocket. From an agent that only has the CLI, prefer breaking the drag into a single `gesture` call that contains the full sequence — or use `button swipe_home` for the specific case of swipe-to-home.

For ad-hoc drags via the CLI, this minimal sequence works because it issues one socket call per phase but the simulator coalesces them when issued rapidly:

```sh
npx serve-sim gesture '{"type":"begin","x":0.5,"y":0.2}'
npx serve-sim gesture '{"type":"move","x":0.5,"y":0.5}'
npx serve-sim gesture '{"type":"move","x":0.5,"y":0.8}'
npx serve-sim gesture '{"type":"end","x":0.5,"y":0.8}'
```

The agent should accept that this may produce a long-press start on some hosts. For reliable drags, drive the WebSocket directly (see `references/endpoints.md`).

### Pinch to zoom in

```sh
npx serve-sim gesture '{"type":"begin","x1":0.4,"y1":0.5,"x2":0.6,"y2":0.5}'
npx serve-sim gesture '{"type":"move","x1":0.25,"y1":0.5,"x2":0.75,"y2":0.5}'
npx serve-sim gesture '{"type":"end","x1":0.25,"y1":0.5,"x2":0.75,"y2":0.5}'
```

### Pull down Notification Center (top edge)

```sh
npx serve-sim gesture '{"type":"begin","x":0.5,"y":0.02,"edge":2}'
npx serve-sim gesture '{"type":"move","x":0.5,"y":0.4,"edge":2}'
npx serve-sim gesture '{"type":"end","x":0.5,"y":0.4,"edge":2}'
```

### Swipe back from left edge

```sh
npx serve-sim gesture '{"type":"begin","x":0.01,"y":0.5,"edge":1}'
npx serve-sim gesture '{"type":"move","x":0.5,"y":0.5,"edge":1}'
npx serve-sim gesture '{"type":"end","x":0.5,"y":0.5,"edge":1}'
```

## Why `tap` is preferred

The CLI's `gesture` subcommand opens a fresh WebSocket on each invocation. When you issue `begin` and `end` as two separate calls, the round-trip plus socket setup introduces a delay of tens of milliseconds. The simulator's HID layer measures touch duration; anything beyond ~100ms reads as a long-press, not a tap.

The `tap` subcommand exists specifically to bypass this: it issues `begin` and `end` over a single connection with negligible latency, producing a true tap every time. There is no good reason to emulate a tap with `gesture`.
