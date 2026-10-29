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

> **Xcode 27 keyboard input:** Device Hub must be running with the target simulator window visible and frontmost. macOS may also require the app that launched `serve-sim` (for example Terminal) to be enabled in **System Settings → Privacy & Security → Accessibility**. Xcode 26 and older keep using the legacy simulator HID path. Set `SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD=1` to opt out of the Xcode 27 bridge.

## iPhone Duo

With Xcode 27.1 and the iOS 27.1 runtime, the preview exposes **Closed**,
**Book**, and **Open** controls for iPhone Duo. Selecting one drives
the simulator's hinge and follows the active panel's framebuffer. Touches use the panel's own
integrated digitizer; volume and power controls use a guest HID service.

```sh
serve-sim fold 0 -d <udid>
serve-sim fold 180 -d <udid>      # flat, 180°
serve-sim fold 130 -d <udid>      # 130°
serve-sim fold 100 -d <udid>
```

Commands wait for the guest to acknowledge dispatch. Invalid angles and failed
commands do not change capture. The bundled `simduo/serve-sim-duo-hid` executable
runs inside the simulator and exits with the device session.

Duo uses one interactive RealityKit preview of the installed Xcode model, with
live screen textures and touches mapped to each bent screen half. Apple's model
stays in Xcode; it is not redistributed. Rotate animates the device and pose
icons together. Motion uses a faster 1000×900 render target and sharpens once to 1500×1350 when settled.
Screenshots capture the active app framebuffer, including the unfolded inner display.

Use the pose buttons or hold **Alt** to reveal the continuous hinge slider.
Pinch gestures do not fold the device.
Power, camera, and volume controls follow the device's physical edges, fade in
when the cursor is nearby, and stay hidden during pose animation. They support
press-and-hold. The main control bar has no volume menu or 2D/3D mode toggle.

See the [feature contract and regression checklist](../../.agents/skills/serve-sim-duo-verification/references/expected-behavior.md)
for appearance, folding, rotation, controls, screenshot, and performance checks.

The preview follows hinge changes made in Device Hub. The pose toolbar offers
exactly three presets: Closed (0°), Book (130°), and Open (180°). Set any other
angle with `serve-sim fold <deg>`; use Rotate for orientation. SpringBoard primary-display events choose the captured panel,
including intermediate poses that depend on whether you were opening or closing.
Until guest readback arrives, a 90° threshold provides the initial fallback.
The runtime decides which intermediate poses apps adopt.

Xcode 27 Device Hub can disconnect legacy touch/keyboard services. If input
stops working, run `serve-sim repair-input -d <udid>`. **This restarts SpringBoard
and closes running apps.** Restart serve-sim afterward to reconnect guest HID
services, then reopen your app. This repair is explicit, never automatic.

If Device Hub is stuck on “Connecting display…” and `xcrun simctl io <udid>
enumerate` lists no framebuffer ports, streaming cannot start until the simulator's
display connection is restored. Duo relies on private beta APIs and the selected
Xcode's `V68.usdz` model; compatibility must be rechecked after SDK updates.

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
serve-sim fold <deg> [-d udid]  Set a Duo hinge angle (0–180)
serve-sim repair-input [-d udid]         Repair Device Hub input (restarts apps)
serve-sim memory-warning [-d udid]    Simulate a memory warning
serve-sim event-log [-d udid]         Show recent simulator events
serve-sim exec <command...> [-d udid] Run a host shell command through a server
                                      started with --allow-exec. One argument
                                      is a shell line (exec "xcrun simctl list");
                                      several are quoted as an argv
serve-sim doctor [-d udid]            Collect redacted diagnostics for bug reports
                                      (--json, --out <file>)
serve-sim record [-d udid]            Record the screen to an MP4 (native resolution,
                                      60 fps H.264); Ctrl+C stops. -o <file>,
                                      -t <duration>, --codec h264|hevc, --fps, --bitrate

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
      --allow-exec    Enable the host shell (/exec, {command} frames on
                      /exec-ws, `serve-sim exec`) and .ipa installs from
                      the preview. Off by default
  -q, --quiet         JSON-only output
      --no-preview    Skip the web UI; stream in foreground only
      --panes <panes> Initially open preview panes: devices, tools, devtools,
                      or none
      --fit           Initially size the simulator to fit the preview viewport
      --theme <theme> Set simulator appearance before opening the preview:
                      light or dark
      --codec <codec> Stream codec for the preview UI: 'auto' (H.264 when the
                      browser can decode it) or 'mjpeg' (force software JPEG —
                      e.g. on VMs without H.264 encode)
      --max-bitrate <Mbps>
                      Cap the H.264 stream bitrate (default scales with
                      screen size, 6-30 Mbps). Also read from
                      SERVE_SIM_MAX_BITRATE
      --device-set <path>
                      Use this CoreSimulator device set instead of Xcode's
                      default (simctl --set). Also read from
                      SERVE_SIM_DEVICE_SET
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
serve-sim --panes devices,tools --fit  # start with selected panes open and fit the simulator
serve-sim --theme dark                 # start the simulator in Dark Mode
serve-sim --allow-exec                 # enable `serve-sim exec` and .ipa drag-to-install
serve-sim --max-bitrate 8              # cap H.264 at 8 Mbps (slow links / shared hosts)
serve-sim --device-set ~/pool <udid>   # a simulator of another device set

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

### Remote access (`--auth-token`)

Requests that don't come straight from this machine — LAN clients, tunnels, reverse proxies — are refused unless the server is started with `--auth-token <token>` (or `SERVE_SIM_AUTH_TOKEN`). CLI and scripted clients send `Authorization: Bearer <token>`. To share the preview with a browser, send the link with the token in the URL fragment:

```
http://<host>:3200/#token=<token>
```

Browsers never send the fragment to the server, so the token stays out of request lines and server/proxy logs. The page that loads first is a small auth bootstrap (it contains no secrets): it reads the fragment, removes it from the address bar and history, and POSTs it in a header to the same-origin `/auth` endpoint, which sets an HttpOnly, `SameSite=Lax` cookie and the page reloads. `/auth` only accepts same-origin `POST`s, compares in constant time, and locks out after 10 wrong tokens a minute. A `?token=` query parameter is never accepted.

### Host shell (`--allow-exec`)

The host shell — `POST /exec`, `{command}` frames on the `/exec-ws` control channel, and `serve-sim exec` — runs commands on the host, so it is off unless the server is started with `--allow-exec`; otherwise `/exec` answers `403 {"error":"exec disabled; start with --allow-exec"}` and `{command}` frames get `exec disabled`. Installing an app (dropping an `.ipa` on the preview) runs arbitrary code on the host too, so it also requires `--allow-exec` (`installApp requires --allow-exec`). The other preview tools (screenshots, camera, permissions, location, media drops, reveal in Finder) don't need it: they use fixed, validated host actions with no shell, available to loopback same-origin pages. Even when enabled, `/exec` is loopback-only and requires a per-session token that is never sent in any HTTP response: the server writes it to an owner-only file under `$TMPDIR/serve-sim/exec-tokens/` (removed on stop), and `serve-sim exec` reads it from there. A raw TCP forward of the preview port (`ssh -R`, socat) looks like a local client, so only enable `--allow-exec` on a port nobody else can reach. Note that `installApp` needs no exec token: with `--allow-exec` it only requires a same-origin loopback page, so anyone who can reach an `--allow-exec` port through a raw `ssh -R` or socat forward can install (and so run) arbitrary apps on the host.

`--detach` and `--no-preview` reuse a running server only when it was started with the same `--auth-token` (or with none on both sides) and the same `--allow-exec` setting (on or off on both sides); otherwise they exit with an error — stop the old server with `serve-sim -k <udid>` first.

### Device sets (`--device-set`)

Tools that keep simulators in a CoreSimulator device set of their own (device pools, CI runners) put them where `simctl list` and Simulator.app never look. `--device-set <path>` (or `SERVE_SIM_DEVICE_SET`, an existing directory) points serve-sim at that set: every `simctl` call gets `--set <path>`, each preview records its set in its state file so previews in different sets never take each other's simulators for shut down, the native capture, input and accessibility bridges look the device up in that set, and per-simulator data (permissions) is read from it. Simulator.app is not opened for such a set, since it only shows Xcode's default one. Subcommands such as `serve-sim camera` take the set from `SERVE_SIM_DEVICE_SET` only; the flag applies to the preview, `--detach` and `--no-preview`. The toolbar's library shell commands (`homeButtonCommand`, the screenshot button) still name no device set; the preview page uses host actions instead.

### Camera

`serve-sim camera <bundle-id>` replaces the simulator's camera feed for a single app. A small host-side helper writes BGRA frames into a POSIX shared-memory region; an injected dylib (`DYLD_INSERT_LIBRARIES`) swizzles AVFoundation inside the simulator process so the app reads from that region instead of the simulator's stub camera.

The helper is one-per-device and outlives any single app launch, so multiple apps on the same simulator can share the feed — just run `serve-sim camera <other-bundle-id>` again to relaunch the next app with the dylib attached. Source changes (`camera switch`) and mirror changes (`camera mirror`) flow through the helper's control socket and don't relaunch the app.

Sources:

- **placeholder** — animated programmatic frames (default).
- **file** — image (PNG/JPEG/HEIC/…) or video (mp4/mov/m4v/webm/…). The CLI sniffs the kind from the extension and falls back to magic bytes for files without an extension.
- **webcam** — live `AVCaptureDevice` (built-in, Continuity, external).

### Screen recording

The record button in the preview toolbar and `serve-sim record` both drive a native recorder in the server: it encodes the simulator framebuffer directly (full native resolution, constant frame rate, hardware H.264/HEVC), independent of the stream codec the viewer uses. Stopping streams the finished MP4 to the client that stopped it (a browser download, or the `-o` file) and deletes the server's temp copy. One recording runs per device; any client may stop it, and a `serve-sim record` whose recording is stopped elsewhere exits with an error instead of saving.

A recording is capped at 30 minutes. At the cap the server finalizes the file and holds it for the client that started it, which collects it automatically. If that client has gone away (tab closed, `serve-sim record` killed), the hold lapses after 5 minutes: then any client may collect it with Stop, and starting a new recording discards it.

Limitations:

- **Rotation is fixed at start.** The file's orientation comes from the simulator's orientation when recording starts; rotating mid-recording leaves the rest of the footage sideways. Stop and start a new recording after rotating.
- **Size changes freeze the video.** A track can't change dimensions, so if the screen size changes mid-recording (e.g. switching the Duo's active panel), frames at the new size are dropped and the rest of the video repeats the last frame at the original size.

## Connectors

`serve-sim` can be used with dev servers, browser, and AI editors for more seamless integration.

### Agent Skill

An [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) ships in [`skills/serve-sim`](skills/serve-sim) — it teaches AI coding agents (Grok, Claude Code, Cursor, Codex CLI, Gemini CLI, and any host implementing the open Agent Skills standard) how to drive a simulator through the CLI: taps, gestures, hardware buttons, rotation, camera injection, and handing the stream off to the host's preview pane.

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

Host-shell features are off unless you pass `allowExec: true`. The middleware reads the helper's state from `$TMPDIR/serve-sim/` and hands the browser same-origin `/.sim/helper/<device>` and `/.sim/devtools` URLs for the stream, interaction WebSocket, and WebKit DevTools; the middleware proxies them to the helper. The helper itself sends no CORS headers and only accepts same-origin WebSockets, so an embedded page can't talk to the helper's port directly.

### Forward WebSocket upgrades

Simulator input, the control channel, and DevTools are WebSockets, so forward your server's `upgrade` events under the mount path to `handleUpgrade`. `handleUpgrade` closes any socket it doesn't own, so leave every other upgrade (HMR, your app's own sockets) to your server's existing handlers:

```ts
const basePath = "/.sim";
const middleware = simMiddleware({ basePath });
app.use(middleware);

const server = app.listen(3000);
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === basePath || pathname.startsWith(`${basePath}/`)) {
    middleware.handleUpgrade(req, socket, head);
  }
  // Anything else belongs to the host server's other upgrade listeners.
});
```

Without that, the page still loads video over HTTP but loses simulator input and DevTools (their sockets never reach the proxy). The same setup exposes the preview to remote viewers behind a single port (the way standalone `serve-sim` does), so the per-device helper port and inspect-webkit bridge can stay local to the host. When terminating TLS at a reverse proxy, forward `X-Forwarded-Proto` so the helper URLs use `https`/`wss` and avoid mixed-content blocks.

Pass `proxyHelpers: false` to hand the page the helper's direct URLs instead; that only works when the page is served from the helper's own origin.

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
