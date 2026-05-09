# serve-sim

The `npx serve` of mobile simulators and emulators.

Host your simulator or emulator for use with Agent tools like Codex, Cursor, or Claude Desktop — locally, over your LAN, or host on a remote machine and tunnel anywhere.

```sh
npx serve-sim
# → Preview at http://localhost:3200
```

https://github.com/user-attachments/assets/fbf890f4-c8c7-4684-82be-d677b8a188f8

`serve-sim` spawns a small platform helper that captures the device framebuffer, exposes it as a browser stream + WebSocket control channel, and serves a React preview UI on top. It works with booted iOS Simulators and connected Android devices or emulators — no app instrumentation required.

## Features 

- Full 60 FPS video stream in the browser on iOS; Android streams through adb screencap.
- Swipe from the bottom to go home.
- Pinch/zoom gestures on iOS by holding the option key.
- Simulator logs are forwarded to the browser for browser-use MCP tools to read from on iOS.
- Drag and drop videos and images to add them to the simulator device on iOS.
- Keyboard commands and hot keys are forwarded to the simulator, including CMD+SHIFT+H to go home.
- Apple Watch, iPad, iOS, and Android support.

## Why?

Hosted simulators and emulators can be hard to test, `serve-sim` enables you to test the hosted infra locally first for faster iteration. When you're ready to host a device remotely, simply tunnel the served URL and users can interact with the simulator or emulator as if it were running locally on their device.

I develop the Expo framework, but this tool is completely agnostic to React Native and can be used for mobile interaction testing.

## Install

Requires Node.js 18+. iOS support requires macOS with Xcode command line tools (`xcrun simctl`). Android support requires Android platform tools (`adb`) and a connected device or running emulator. `bun` is **not** required to run the CLI.

## CLI

```
serve-sim [device...]                 Start preview server (default: localhost:3200)
serve-sim --no-preview [device...]    Stream in foreground without a preview server
serve-sim --platform android [serial] Stream a connected Android device/emulator
serve-sim gesture '<json>' [-d udid]  Send a touch gesture
serve-sim button [name] [-d udid]     Send a button press (default: home)
serve-sim rotate <orientation> [-d udid]
                                      portrait | portrait_upside_down |
                                      landscape_left | landscape_right
serve-sim ca-debug <option> <on|off> [-d udid]
                                      Toggle a CoreAnimation debug flag
                                      (blended|copies|misaligned|offscreen|slow-animations)
serve-sim memory-warning [-d udid]    Simulate a memory warning

Options:
  -p, --port <port>   Starting port (preview default: 3200, stream default: 3100)
  -d, --detach        Spawn helper and exit (daemon mode)
  -q, --quiet         JSON-only output
      --platform <p>  Device platform: ios (default) or android
      --ios           Alias for --platform ios
      --android       Alias for --platform android
      --no-preview    Skip the web UI; stream in foreground only
      --list [device] List running streams
      --kill [device] Kill running stream(s)
```

### Examples

```sh
serve-sim                              # auto-detect booted sim, open preview
serve-sim "iPhone 16 Pro"              # target a specific device
serve-sim --android emulator-5554      # target a connected Android emulator
serve-sim --detach                     # start a background helper, return JSON
serve-sim --list                       # show running streams
serve-sim --kill                       # stop all helpers
```

Multiple booted iOS simulators or connected Android devices are supported — pass several device names/serials, or leave it empty to attach to the default device for the selected platform.

## Connectors

`serve-sim` can be used with dev servers, browser, and AI editors for more seamless integration.

### Claude Code Desktop

Create a `.claude/launch.json` and define a server:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "ios",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["serve-sim"],
      "url": "http://localhost:8081/.sim"
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
// → SSE logs    at /.sim/logs
```

The middleware reads the helper's state from `$TMPDIR/serve-sim/` and forwards the user's browser to the live MJPEG + WebSocket endpoints. CORS is wide-open on the helper, so the page renders without a proxy.

## How it works

```
┌──────────────┐   simctl/adb   ┌─────────────────┐  Stream / WS ┌─────────┐
│ iOS/Android  │ ─────────────► │ serve-sim helper│ ───────────► │ Browser │
└──────────────┘                │ (per-device)    │              └─────────┘
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

The iOS Swift helper (`bin/serve-sim-bin`) is a tiny standalone binary — no Xcode dependency at runtime beyond the local simulator stack. Android uses the local `adb` binary for screencap and input. The CLI embeds the iOS helper via `bun build --compile`, so installing the npm package is enough.

## Development

```sh
bun install
bun run --filter serve-sim build         # build the JS bundles
bun run --filter serve-sim build:swift   # rebuild the Swift helper
bun run --filter serve-sim dev           # watch mode
```

## License

Apache-2.0
