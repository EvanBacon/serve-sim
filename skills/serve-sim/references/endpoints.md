# HTTP and WebSocket endpoints reference

For agents that want to bypass the CLI — for example to drive gestures from a long-running process without forking `npx` per call — serve-sim exposes two surfaces over HTTP.

## Contents

- Device helper routes (`/helper/<udid>/…`, on the preview port)
- Preview middleware (port 3200)
- Authentication
- Discovering the live URLs

## Device helper routes (`/helper/<udid>/…`, same port as the preview)

There is no separate per-device binary or stream port. The preview server serves each device's stream, input WebSocket, and AX routes in-process (a native capture/HID session per device, created on first request) under `<preview-url>/helper/<udid>/`. The `streamUrl` / `wsUrl` from `serve-sim --list -q` already point here.

| Method | Path (under `/helper/<udid>`) | Returns / accepts |
|---|---|---|
| `GET` | `/stream.mjpeg` | MJPEG video stream as `multipart/x-mixed-replace; boundary=frame`. Use this in `<img>` tags. |
| `GET` | `/stream.mjpeg?raw=1` | Same bytes (still multipart-framed) labelled `application/octet-stream`. Use this when consuming from `fetch().body.getReader()` — WebKit refuses multipart responses there. |
| `GET` | `/stream.avcc` | H.264 (AVCC) stream for the preview's decoder. |
| `GET` | `/ws` | Binary WebSocket. Accepts touch / button / orientation / CoreAnimation / memory-warning messages. See "WebSocket message types" below. |
| `GET` | `/config` | JSON `{width: number, height: number, orientation: string}` describing the current display. |
| `GET` | `/health` | JSON `{status: "ok"}`. Use for liveness probes. |
| `GET` | `/ax` | JSON accessibility tree (axe-compatible flat-array shape). 503 `{error: "ax_unavailable", message}` when it can't be read (e.g. nothing in the foreground yet). |
| `GET` | `/foreground` | JSON `{bundleId: string, pid: number}` of the frontmost app. 503 `{error: "foreground_unavailable", message}` when unavailable. |
| `GET` | `/camera/status` | Camera-injection helper state. |

A device that isn't booted (or can't be captured) gets 404.

> Requires serve-sim with [#166](https://github.com/EvanBacon/serve-sim/pull/166) (the auth/exec fix). Older builds send a wildcard `Access-Control-Allow-Origin: *` from the helper routes and have no auth token; never tunnel them.

Because the helper routes are served by the preview server, they get the same auth and origin checks as everything else (below). With #166 the helper routes send no `Access-Control-Allow-Origin` header at all, so only same-origin pages can read them from a browser.

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
| `POST` | `/.sim/exec` | Run a shell command on the host. **Off unless the server was started with `--allow-exec`** (otherwise 403 `{"error":"exec disabled; start with --allow-exec"}`). When on: trusted loopback, same-origin, JSON, and the exec token from the token file (see Authentication). Use `serve-sim exec <command>` rather than calling it yourself. Never available to a remote caller, auth token or not. |
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

Arbitrary host-shell commands (`/exec` and `{id, command}` frames on `/exec-ws`) are off in the middleware unless you pass `allowExec: true`. The preview UI's host tools (screenshots, camera, permissions, media/app drops, reveal in Finder) don't need it: they use validated host actions (see Authentication).

## Authentication

> Requires serve-sim with [#166](https://github.com/EvanBacon/serve-sim/pull/166). Older builds have no `--auth-token`, no loopback/remote distinction, and no `serve_sim_auth` cookie; never expose them beyond loopback.

serve-sim distinguishes a **trusted loopback** request from everything else. Trusted loopback means all three: the real TCP peer address is loopback (`127.0.0.0/8` or `::1`), the request carries no proxy/forwarding headers (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP`, `Tailscale-*`, `ngrok-*`, …), and `Host` names a loopback host. LAN clients, tunnels and reverse proxies that add those headers, and rebound `Host`s are all "remote". `Host`/`Origin` never grant trust on their own.

> **A raw TCP forward looks local.** `ssh -R`, `socat`, or a reverse proxy that strips forwarding headers delivers remote clients from a loopback socket with no forwarding headers, so serve-sim treats them as trusted loopback: no auth token needed, and shell access if `--allow-exec` is on. `ssh -L` from a machine you control is fine (only people with SSH access to the Mac reach it). **Never combine a tunnel or forward with `--allow-exec`.**

- **Auth token (`--auth-token <token>` / `SERVE_SIM_AUTH_TOKEN`).** Gates *all* non-loopback access: the API, the stream and helper routes, `/config`, `/ax`, DevTools, the HID/stream WebSockets, and the grid routes. A remote request gets 403 if the server has no token, 401 if the token is missing or wrong. Send it as `Authorization: Bearer <token>` (or let a browser pick up the `serve_sim_auth` cookie via the one-time `<url>/?token=...` redirect). This token does **not** unlock `/exec`. The state file records only its SHA-256, and `--detach` / foreground start refuse to reuse a running server whose token differs (`serve-sim is already running for <udid> but was started with a different --auth-token…`); stop it with `serve-sim -k <udid>` and start again.
- **Host shell (`--allow-exec`).** Off by default: `POST /exec` answers 403 `{"error":"exec disabled; start with --allow-exec"}`, and `{id, command}` frames on the `/exec-ws` control socket get the same message back. Start the server with `--allow-exec` (or pass `allowExec: true` to the middleware) to turn it on. Even then a remote caller can never run a command, auth token or not. The state file records whether a server has it on, and `--detach` / foreground start refuse to reuse a running server whose `--allow-exec` setting differs from the one you passed (`…was started without --allow-exec` / `…was started with --allow-exec, but it was not given now`); stop it with `serve-sim -k <udid>` and start again.
- **Exec token.** With `--allow-exec`, `/exec` also needs a per-process random token that no HTTP response contains (not the preview HTML, `/api`, `/api/events`, or the state file). The server writes it to `$TMPDIR/serve-sim/exec-tokens/<port>.token` (mode 0600, owner-only directory) and deletes it on stop and on `serve-sim -k`. `serve-sim exec <command...> [-d udid]` reads that file and POSTs to `http://127.0.0.1:<port>/exec` for you; it prints the command's stdout/stderr and exits with its exit code. It shell-quotes each argument, so `serve-sim exec ls "my dir"` runs exactly that argv; for pipes, redirects, or `&&`, pass a shell yourself: `serve-sim exec sh -c 'xcrun simctl list | head'`. Shell commands over `/exec-ws` need the same token: the socket's first frame must be `{"token":"<exec token>"}`, on top of `--allow-exec` and a trusted loopback socket with a same-origin `Origin`; otherwise `{id, command}` frames get exit 126 and `exec requires the exec token`. The preview page never holds the token, so it can't run shell commands.
- **Host actions (preview UI).** The page's host tools send `{id, rpc:{method, params}}` frames on `/exec-ws` instead of shell text: named actions (screenshot, camera, permissions, uploads, app install, location, …) whose params the server validates and runs as a fixed argv against a booted simulator, with no shell. They work without `--allow-exec`, but only for a trusted loopback socket with a same-origin `Origin`; anything else gets `{id, error:"host actions are only available to loopback clients"}`. A remote (authenticated) page still gets SSE subscriptions and simulator settings over the socket, just not host actions.

## Discovering the live URLs

The simplest path is the CLI:

```sh
npx serve-sim --list -q
```

Returns a JSON array of running streams, each with `url`, `streamUrl`, `wsUrl`, `device`, `pid`, `port`. An agent should call this once on entry to discover ports — the port is not guaranteed to be 3200 if another process holds it.

Alternatively, read state files directly:

```sh
ls $TMPDIR/serve-sim/server-*.json
cat $TMPDIR/serve-sim/server-<udid>.json
```

This is faster than spawning `npx` but couples you to the file format. Prefer `--list -q` for portability.
