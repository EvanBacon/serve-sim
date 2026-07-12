# serve-sim

The `npx serve` of Apple Simulators. 

Host your simulator for use with Agent tools like Codex, Cursor, or Claude Desktop — locally, over your LAN, or host on a remote mac and tunnel anywhere. 

```sh
npx serve-sim
# → Preview at http://localhost:3200
```

https://github.com/user-attachments/assets/fbf890f4-c8c7-4684-82be-d677b8a188f8

`serve-sim` spawns a small Swift helper that captures the simulator's framebuffer via `simctl io`, exposes it as an MJPEG stream + WebSocket control channel, and serves a React preview UI on top. It works with any booted iOS Simulator — no Xcode plugin, no instrumentation in your app.

## Features 

- Full 60 FPS video stream in the browser.
- Swipe from the bottom to go home.
- gestures like pinch to zoom by holding the option key.
- Simulator logs are forwarded to the browser for browser-use MCP tools to read from.
- Recent simulator actions are available in the browser tools panel and `serve-sim event-log`.
- Drag and drop videos and images to add them to the simulator device. 
- Keyboard commands and hot keys are forwarded to the simulator, including CMD+SHIFT+H to go home.
- Apple Watch, iPad, and iOS support.

## Why?

Hosted simulators can be hard to test, `serve-sim` enables you to test the hosted infra locally first for faster iteration. When you're ready to host a simulator remotely, simply tunnel the served URL and users can interact with the simulator as if it were running locally on their device.

I develop the Expo framework, but this tool is completely agnostic to React Native and can be used for any iOS interaction you need.

## Install

Requires macOS with Xcode command line tools (`xcrun simctl`) and a [maintained Node.js LTS release](https://nodejs.org/en/about/previous-releases) (currently Node 20+). Older or end-of-life Node versions are not supported. `bun` is **not** required to run the CLI. Camera injection uses a host-side helper built for macOS 14+.

> **Note:** Apple Silicon (arm64) only. The bundled `serve-sim-bin` helper ships as an arm64 binary and does not run on Intel (x86_64) Macs.

## CLI

```
serve-sim [device...]                 Start preview server (default: localhost:3200)
serve-sim --no-preview [device...]    Stream in foreground without a preview server
serve-sim gesture '<json>' [-d udid]  Send a touch gesture
serve-sim button [name] [-d udid]     Send a button press (default: home)
serve-sim type <text> [-d udid]       Type text via the simulator keyboard
                                      (US keyboard only; also --stdin / --file <path>)
serve-sim rotate <orientation> [-d udid]
                                      portrait | portrait_upside_down |
                                      landscape_left | landscape_right
serve-sim ca-debug <option> <on|off> [-d udid]
                                      Toggle a CoreAnimation debug flag
                                      (blended|copies|misaligned|offscreen|slow-animations)
serve-sim memory-warning [-d udid]    Simulate a memory warning
serve-sim event-log [-d udid]         Show recent simulator events

serve-sim camera <bundle-id> [-d udid] [source-options]
                                      Inject a synthetic camera feed and (re)launch the app
serve-sim camera switch <placeholder|webcam|file> [arg] [-d udid]
                                      Hot-swap the running helper's source (no relaunch)
serve-sim camera mirror <auto|on|off> [-d udid]
                                      Hot-swap preview-layer mirror mode
serve-sim camera status [-d udid]     Print helper state as JSON ({alive, source, ...})
serve-sim camera --list-webcams       List host camera devices
serve-sim camera --stop-webcam [-d udid]
                                      Stop the camera helper for a device

Options:
  -p, --port <port>   Starting port (preview default: 3200; helper default: 3100)
  -d, --detach        Spawn helper and exit (daemon mode)
  -q, --quiet         JSON-only output
      --no-preview    Skip the web UI; stream in foreground only
      --codec <codec> Stream codec for the preview UI: 'auto' (H.264 when the
                      browser can decode it) or 'mjpeg' (force software JPEG —
                      e.g. on VMs without H.264 encode)
      --list [device] List running streams
      --kill [device] Kill running stream(s)

Camera options (used with `serve-sim camera <bundle-id>`):
  -f, --file <path>          Image or video file (kind auto-detected from
                             extension/magic bytes; videos loop at native FPS)
      --webcam [name]        Live host webcam (defaults to the built-in
                             front camera when [name] is omitted)
      --mirror [on|off|auto] Override preview-layer mirroring (default: auto =
                             front mirrored, back not). Data-output buffers
                             are never auto-mirrored, matching AVF defaults.
      --no-mirror            Shortcut for --mirror off
      --build                Rebuild the dylib + helper from source
```

### Examples

```sh
serve-sim                              # auto-detect booted sim, open preview
serve-sim "iPhone 16 Pro"              # target a specific device
serve-sim --detach                     # start a background helper, return JSON
serve-sim --list                       # show running streams
serve-sim --kill                       # stop all helpers

# Type text into the focused field
serve-sim type "Hello, world!"
echo "from stdin" | serve-sim type --stdin
serve-sim type --file ./snippet.txt

# Camera injection
serve-sim camera com.acme.MyApp                            # animated placeholder
serve-sim camera com.acme.MyApp --webcam                   # default webcam
serve-sim camera com.acme.MyApp --webcam "MacBook Pro Camera"
serve-sim camera com.acme.MyApp --file ~/Pictures/face.png # static image
serve-sim camera com.acme.MyApp --file ~/Movies/loop.mp4   # looping video

# Hot-swap source on a running helper (no app relaunch)
serve-sim camera switch placeholder
serve-sim camera switch webcam
serve-sim camera switch ~/Movies/loop.mp4                  # auto-detects file kind

# Other helpers
serve-sim camera mirror on
serve-sim camera status                                    # JSON: alive, source, mirror
serve-sim camera --list-webcams
serve-sim camera --stop-webcam
```

Multiple booted simulators are supported — pass several device names, or leave it empty to attach to all of them.

### Camera

`serve-sim camera <bundle-id>` replaces the simulator's camera feed for a single app. A small host-side helper writes BGRA frames into a POSIX shared-memory region; an injected dylib (`DYLD_INSERT_LIBRARIES`) swizzles AVFoundation inside the simulator process so the app reads from that region instead of the simulator's stub camera.

The helper is one-per-device and outlives any single app launch, so multiple apps on the same simulator can share the feed — just run `serve-sim camera <other-bundle-id>` again to relaunch the next app with the dylib attached. Source changes (`camera switch`) and mirror changes (`camera mirror`) flow through the helper's control socket and don't relaunch the app.

Sources:

- **placeholder** — animated programmatic frames (default).
- **file** — image (PNG/JPEG/HEIC/…) or video (mp4/mov/m4v/webm/…). The CLI sniffs the kind from the extension and falls back to magic bytes for files without an extension.
- **webcam** — live `AVCaptureDevice` (built-in, Continuity, external).

## Connectors

`serve-sim` can be used with dev servers, browser, and AI editors for more seamless integration.

### Agent Skill

An [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) ships in [`skills/serve-sim`](skills/serve-sim) — it teaches AI coding agents (Claude Code, Cursor, Codex CLI, Gemini CLI, and any host implementing the open Agent Skills standard) how to drive a simulator through the CLI: taps, gestures, hardware buttons, rotation, camera injection, and handing the stream off to the host's preview pane.

```sh
bunx add-skill EvanBacon/serve-sim
# in Claude Code:
/plugin marketplace add EvanBacon/serve-sim
```

See [`skills/serve-sim/README.md`](skills/serve-sim/README.md) for the full capability list.

### Claude Code Desktop

Create a `.claude/launch.json` and define a server:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "Apple",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["serve-sim"],
      "port": 3200
    }
  ]
}
```

### Expo

Automatically start the serve-sim process with `npx expo start` and access the URL at `http://localhost:8081/.sim`.

First, customize the `metro.config.js` file (`bunx expo customize`):

```js
// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const connect = require("connect");
const { simMiddleware } = require("serve-sim/middleware");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

config.server = config.server || {};
const originalEnhanceMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (metroMiddleware, server) => {
  const middleware = originalEnhanceMiddleware
    ? originalEnhanceMiddleware(metroMiddleware, server)
    : metroMiddleware;
  const app = connect();
  app.use(simMiddleware({ basePath: "/.sim" }));
  app.use(middleware);
  return app;
};

module.exports = config;
```

## Embed in your dev server

`serve-sim/middleware` is a Connect-style middleware that mounts the same preview UI inside your existing dev server (Metro, Vite, Next, plain Express, etc.). Run `serve-sim --detach` once to start the streaming helper, then add the middleware:

```ts
import { simMiddleware } from "serve-sim/middleware";

app.use(simMiddleware({ basePath: "/.sim" }));
// → preview HTML at /.sim
// → state JSON  at /.sim/api
```

The middleware reads the helper's state from `$TMPDIR/serve-sim/` and points the browser at the helper's stream, interaction WebSocket, and WebKit DevTools endpoints. By default those URLs target the helper's own port directly (CORS is wide-open on the helper), so a plain `app.use(...)` mount works without touching your server's WebSocket handling.

### Single-port / remote proxying

To expose the preview to remote viewers behind a single port (the way standalone `serve-sim` does), pass `proxyHelpers: true`. The browser then reaches the stream, control socket, and DevTools through same-origin `/.sim/helper/<device>` and `/.sim/devtools` URLs, so the per-device helper port and inspect-webkit bridge can stay local to the host. This routes WebSockets through the middleware, so you must forward your server's `upgrade` events to `handleUpgrade`:

```ts
const middleware = simMiddleware({ basePath: "/.sim", proxyHelpers: true });
app.use(middleware);

const server = app.listen(3000);
server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket, head));
```

If you enable `proxyHelpers` but don't wire `upgrade`, the page still loads video over HTTP but loses simulator input and DevTools (their sockets never reach the proxy). When terminating TLS at a reverse proxy, forward `X-Forwarded-Proto` so the helper URLs use `https`/`wss` and avoid mixed-content blocks.

## How it works

```
┌──────────────┐   simctl io   ┌─────────────────┐  MJPEG / WS  ┌─────────┐
│ iOS Simulator│ ────────────► │ serve-sim-bin   │ ───────────► │ Browser │
└──────────────┘   (Swift)     │ (per-device)    │              └─────────┘
                               └─────────────────┘
                                       ▲
                                  state file in
                                $TMPDIR/serve-sim/
                                       ▲
                               ┌──────────────────┐
                               │ serve-sim CLI /  │
                               │ middleware       │
                               └──────────────────┘
```

The Swift helper (`bin/serve-sim-bin`) is a tiny standalone binary — no Xcode dependency at runtime. The CLI embeds it via `bun build --compile`, so installing the npm package is enough.

## Development

```sh
bun install
bun run --filter serve-sim build         # build the JS bundles
bun run --filter serve-sim build:swift   # rebuild the Swift helper
bun run --filter serve-sim dev           # watch mode
```

## License

Apache-2.0
