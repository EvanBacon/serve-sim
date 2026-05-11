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