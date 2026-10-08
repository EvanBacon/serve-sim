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

The helper routes are served in-process by the preview server, which applies the auth and origin checks below. (Older standalone helper processes set a wildcard `Access-Control-Allow-Origin: *`; the current in-process server does not, and sends a reflected CORS header only to a trusted loopback page on another port.)

### WebSocket message types

The `/ws` endpoint accepts binary frames. **Every frame is one tag byte followed by UTF-8 JSON** — there is no packed binary-struct format (no `0x10`/`0x11`), and no `serve-sim-client/touch-codec` package to import; build the frame yourself:

```
[tag:u8] [JSON bytes...]
```

Tags the server handles (see `handleHidMessage` in `device-session.ts`):

| Tag | Meaning | JSON body |
|---|---|---|
| `0x03` | Touch | `{type: "begin"\|"move"\|"end", x, y, edge?}` — `x`,`y` normalized `0..1`; `edge` 0–4 as in [gestures.md](gestures.md) |
| `0x04` | Button | `{button}` (e.g. `"home"`); hardware buttons also take `{page, usage, phase}` |
| `0x05` | Multi-touch | `{type, x1, y1, x2, y2}` |
| `0x06` | Keyboard | `{type: "down"\|"up", usage}` (USB HID Usage Page 0x07) |
| `0x07` | Orientation | `{orientation: "portrait"\|"portrait_upside_down"\|"landscape_left"\|"landscape_right"}` |
| `0x08` | CoreAnimation debug | `{option, enabled}` |
| `0x09` | Memory warning | empty body |
| `0x0a` | Digital crown | `{delta}` |
| `0x0b` | Scroll | `{dx, dy, x?, y?}` (deltas are a fraction of the display) |
| `0x0c` | Software keyboard toggle | empty body |
| `0x0d` | Preferred screen size | `{width, height}` |
| `0x0e` | Duo pose / hinge | `{pose?, hinge?}` |

A tap is `0x03 begin` then `0x03 end` on the same socket ~40 ms apart.

**Frames the server sends you:** a config frame with first byte `0x82` and body `{width, height, orientation, ...}`, pushed on connect and whenever the display changes. (Duo sessions also send a projection frame.) Read `0x82` for live dimensions; ignore other inbound frames if you don't need them.

For most agents, the CLI is the right entry point. Use the WebSocket directly only when you need sub-CLI-latency input streams (drag animations, multi-finger gestures).

## Preview middleware (default port 3200)

This is a Node middleware that serves the preview UI and proxies state. It can be run standalone (`npx serve-sim`) or embedded in another dev server (`serve-sim/middleware`).

| Method | Path | Returns / accepts |
|---|---|---|
| `GET` | `/.sim` | The preview HTML page (React UI showing the simulator stream). |
| `GET` | `/.sim/api` | JSON state: `{device, pid, port, url, streamUrl, wsUrl}`. |
| `GET` | `/.sim/ax` | SSE stream of accessibility tree snapshots. |
| `POST` | `/.sim/exec` | Run a shell command on the host. **Loopback same-origin only**, and must carry the per-process exec token. Never available to a remote/tunneled or cross-origin caller, token or not. |
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

serve-sim distinguishes a **trusted loopback** request (loopback TCP peer, no proxy/forwarding headers, loopback `Host`) from everything else (LAN, tunnel, reverse proxy, or a rebound `Host` — all "remote").

- **Exec token (`/exec`, and shell commands over the `/exec-ws` control socket).** A per-process random token, injected only into the preview page served to a trusted loopback same-origin browser. `/exec` runs a command only for a trusted loopback request whose `Origin` matches its loopback `Host` and that presents this token. A remote caller can never run a shell command, even with the auth token below.
- **Auth token (`--auth-token <token>` / `SERVE_SIM_AUTH_TOKEN`).** Gates *all* non-loopback access: the API, the stream and helper routes, `/config`, `/ax`, DevTools, the HID/stream WebSockets, and the grid routes. A remote request without it gets 401/403. Send it as `Authorization: Bearer <token>` (or let a browser pick up the `serve_sim_auth` cookie via the one-time `<url>/?token=...` redirect). This token does **not** unlock `/exec`.
- The exec token lives only in the trusted-loopback preview page's injected config (`window.__SIM_PREVIEW__.execToken`). It is **not** written to the state file under `$TMPDIR/serve-sim/server-{udid}.json`; `GET /api`, `GET /api/events`, and a remote preview page never return it.

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
