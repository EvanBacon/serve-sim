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
- Drag and drop videos and images to add them to the simulator device. 
- Keyboard commands and hot keys are forwarded to the simulator, including CMD+SHIFT+H to go home.
- Apple Watch, iPad, and iOS support.

## Why?

Hosted simulators can be hard to test, `serve-sim` enables you to test the hosted infra locally first for faster iteration. When you're ready to host a simulator remotely, simply tunnel the served URL and users can interact with the simulator as if it were running locally on their device.

I develop the Expo framework, but this tool is completely agnostic to React Native and can be used for any iOS interaction you need.

## Install

Requires macOS with Xcode command line tools (`xcrun simctl`) and Node.js 18+. `bun` is **not** required to run the CLI.

## CLI

```
serve-sim [device...]                 Start preview server (default: localhost:3200)
serve-sim --no-preview [device...]    Stream in foreground without a preview server
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
      --no-preview    Skip the web UI; stream in foreground only
      --list [device] List running streams
      --kill [device] Kill running stream(s)
```

### Examples

```sh
serve-sim                              # auto-detect booted sim, open preview
serve-sim "iPhone 16 Pro"              # target a specific device
serve-sim --detach                     # start a background helper, return JSON
serve-sim --list                       # show running streams
serve-sim --kill                       # stop all helpers
```

Multiple booted simulators are supported — pass several device names, or leave it empty to attach to all of them.

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
      "port": 3200,
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
