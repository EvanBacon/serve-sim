# HTTP and WebSocket endpoints reference

For agents that want to bypass the CLI — for example to drive gestures from a long-running process without forking `npx` per call — serve-sim exposes two surfaces over HTTP.

## Contents

- Stream server (Swift helper, port 3100)
- Preview middleware (port 3200)
- Authentication
- Discovering the live URLs

## Stream server (Swift helper, default port 3100)

This is the per-device binary started for each booted simulator. It serves the video stream and accepts input over a binary WebSocket.

| Method | Path | Returns / accepts |
|---|---|---|
| `GET` | `/stream.mjpeg` | MJPEG video stream as `multipart/x-mixed-replace; boundary=frame`. Use this in `<img>` tags. |
| `GET` | `/stream.mjpeg?raw=1` | Same JPEG bytes as `application/octet-stream`. Use this when consuming from `fetch().body.getReader()` — WebKit refuses multipart responses there. |
| `GET` | `/ws` | Binary WebSocket. Accepts touch / button / orientation / CoreAnimation / memory-warning messages. See "WebSocket message types" below. |
| `GET` | `/config` | JSON `{width: number, height: number, orientation: string}` describing the current display. |
| `GET` | `/health` | JSON `{status: "ok"}`. Use for liveness probes. |
| `GET` | `/ax` | JSON accessibility tree (axe-compatible flat-array shape). |
| `GET` | `/foreground` | JSON `{bundleId: string, pid: number}` of the frontmost app. |

CORS is wide-open (`Access-Control-Allow-Origin: *`) on this server.

### WebSocket message types

The `/ws` endpoint accepts binary frames. Two formats are in use today:

**Touch (prefix `0x10`)** — 12 or 13 bytes:

```
[0x10] [subtype:u8] [x:f32] [y:f32] [seq:u16] [edge:u8?]
```

- `subtype`: 0 = begin, 1 = move, 2 = end
- `x`, `y`: normalized floats in `[0, 1]`
- `seq`: monotonic 16-bit counter the server uses to coalesce frames
- `edge`: optional, 0–4 as in [gestures.md](gestures.md)

**Multi-touch (prefix `0x11`)** — 20 bytes:

```
[0x11] [subtype:u8] [x1:f32] [y1:f32] [x2:f32] [y2:f32] [seq:u16]
```

A JSON channel also exists with these message-type bytes; refer to the helper source if you need them:

- `0x03` — JSON touch event (legacy)
- `0x04` — JSON button event
- `0x05` — JSON multi-touch event (legacy)
- `0x06` — JSON keyboard event (`{type: down|up, usage: u32}`, USB HID Usage Page 0x07)
- `0x07` — JSON orientation event
- `0x08` — JSON CoreAnimation debug toggle
- `0x09` — empty body, triggers memory warning

For most agents, the CLI is the right entry point. Use the WebSocket directly only when you need sub-CLI-latency input streams (drag animations, multi-finger gestures).

## Preview middleware (default port 3200)

This is a Node middleware that serves the preview UI and proxies state. It can be run standalone (`npx serve-sim`) or embedded in another dev server (`serve-sim/middleware`).

| Method | Path | Returns / accepts |
|---|---|---|
| `GET` | `/.sim` | The preview HTML page (React UI showing the simulator stream). |
| `GET` | `/.sim/api` | JSON state: `{device, pid, port, url, streamUrl, wsUrl}`. |
| `GET` | `/.sim/logs` | SSE stream of simulator console logs (text/event-stream, NDJSON events). |
| `GET` | `/.sim/ax` | SSE stream of accessibility tree snapshots. |
| `POST` | `/.sim/exec` | Run a shell command on the host. **Requires a bearer token.** |
| `POST` | `/.sim/appstate` | SSE-like stream of frontmost-app changes. |
| `GET` | `/.sim/devtools` | WebKit Inspector bridge for in-app web views. |
| `POST` | `/grid/api` | List running devices. |
| `POST` | `/grid/api/start` | Spawn a helper for a specific device. |
| `POST` | `/grid/api/shutdown` | Shut down a specific device. |
| `POST` | `/grid/api/memory` | Memory usage report. |

When embedding the middleware in another dev server (Metro, Vite, Express), the `basePath` is configurable:

```ts
import { simMiddleware } from "serve-sim/middleware";
app.use(simMiddleware({ basePath: "/.sim" }));
```

## Authentication

- The Swift stream server has no authentication. It listens on `0.0.0.0` by default — be careful when tunneling.
- The preview middleware's `/.sim/exec` endpoint requires a bearer token. The token is printed when `serve-sim` starts and is stored in the per-device state file under `$TMPDIR/serve-sim/server-{udid}.json`. Use `Authorization: Bearer <token>`.

## Discovering the live URLs

The simplest path is the CLI:

```sh
npx serve-sim --list -q
```

Returns a JSON array of running streams, each with `url`, `streamUrl`, `wsUrl`, `device`, `pid`, `port`. An agent should call this once on entry to discover ports — they are not guaranteed to be 3200/3100 if other processes occupy those defaults.

Alternatively, read state files directly:

```sh
ls $TMPDIR/serve-sim/server-*.json
cat $TMPDIR/serve-sim/server-<udid>.json
```

This is faster than spawning `npx` but couples you to the file format. Prefer `--list -q` for portability.
