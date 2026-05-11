- Test-driven development where possible.
- Prefer kebab-case for all TS/JS files.
- Avoid low-opacity for icons.

## E2E testing with agent-browser

The serve-sim web UI streams the iOS Simulator and forwards clicks, so end-to-end
behavior can be driven from a browser with the `agent-browser` CLI:

1. Build: `bun run packages/serve-sim/build.ts` (rebuilds the dylib + helper into
   `packages/serve-sim/dist/simcam/`).
2. Boot a simulator and start the server: `node packages/serve-sim/dist/serve-sim.js --port 3399`.
3. Drive the UI: `agent-browser open http://localhost:3399`, then `snapshot`,
   `click @eN`, `upload input[type=file] <path>`, `screenshot <path>`, etc.
4. Tap inside the simulator with `agent-browser mouse move <x> <y> && mouse down && mouse up`
   — the canvas isn't in the AX tree, so use pixel coordinates from a screenshot.

## E2E testing via the serve-sim CLI

For headless flows that don't need the browser, drive the simulator entirely
through `serve-sim` subcommands against a running server:

- `serve-sim tap <x> <y> [-d udid]` — single-shot tap at normalized (0..1)
  screen coords. Prefer this over `serve-sim gesture` for taps: each `gesture`
  call opens its own WebSocket, so two back-to-back `begin`/`end` invocations
  land far enough apart to register as a long-press.
- `serve-sim gesture '<json>' [-d udid]` — for drags or multi-step gestures
  that need explicit `begin`/`move`/`end` events.
- `serve-sim button [home|lock|…] [-d udid]` — hardware button.
- `serve-sim camera …` — inject the dylib, hot-swap source, toggle mirror.
- `xcrun simctl openurl booted <url>` — deep-link into apps (faster than
  tapping through Expo Go's recent-projects list).

Typical camera e2e flow: rebuild, `camera --stop-webcam`, `simctl terminate`
the app, `camera <bundleId> --file <img> --mirror on` to re-inject, `openurl`
to load the project, `tap 0.5 0.9` for the shutter, then read the saved JPEG
off disk to verify (see the path under "agent-browser" above).