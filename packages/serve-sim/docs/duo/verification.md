# Duo verification

Validated locally on September 20, 2026 with Xcode 27.1, iOS 27.1 iPhone Duo,
Node 24, and the rebuilt local CLI. Apple's private beta interfaces can change.

## Automated checks

- TypeScript typecheck and lint: pass.
- Unit suite excluding the repository's Darwin integration/E2E list: 420 pass,
  3 existing performance-test skips, no failures.
- Swift `SimNativeSupportTests`: 24 pass.
- Full native/package build: pass.
- Gesture tests dispatch two-pointer, trackpad wheel, and Safari gesture events;
  they verify opening from zero, closing from 180, clamping, cancellation,
  cleanup, and stable mouse scaling across panel-size changes.
- Lifecycle tests cover serialized pose acknowledgement, rejected commands,
  static-frame 3D rendering, reconnect races, and guest primary-panel precedence.

The SDK-dependent iPad placeholder assertion accepts both the older fallback
name and macOS 27's named CoreTypes icon.

## Live simulator checks

The initial implementation was checked against independent `devicectl` hinge samples.
The historical instant-angle matrix below checks `/config` against SpringBoard's
primary-panel events and verifies that the selected panel screenshot is not black.

| Direction | Pose   | Angle | Guest primary panel |
| --------- | ------ | ----: | ------------------- |
| Opening   | Closed |    0° | Cover               |
| Opening   | Tent   |   80° | Cover               |
| Opening   | Table  |  100° | Cover               |
| Opening   | Book   |  130° | Cover               |
| Opening   | Open   |  180° | Inner               |
| Closing   | Book   |  130° | Inner               |
| Closing   | Table  |  100° | Inner               |
| Closing   | Tent   |   80° | Inner               |
| Closing   | Closed |    0° | Cover               |

The initial instant-angle implementation could leave the cover active when
opening to Book. This was a transition bug, not sufficient evidence of intended
hysteresis. Slider and gesture angles remain immediate. Closed → Book now reaches
130° with the inner display active, matching Device Hub. Live WebSocket samples
confirm intermediate angles arrive before the command acknowledgement. A new
lifecycle regression test covers readback during an in-flight pose command;
all 13 lifecycle tests, typecheck, lint, and the rebuilt native package pass.
The table above records the earlier behavior, not the updated preset contract.

The monitor still follows SpringBoard rather than choosing a panel solely from
the hinge angle. Presets do not force an app into a particular layout.

Additional live checks:

- All four orientations reflected in stream configuration.
- App navigation in the 2D view and on the bent 3D inner display.
- Mouse drag-to-open reached the guest and changed the active panel.
- Closed cover and folded inner textures inspected in the browser.
- Volume-up input observed in SpringBoard's physical-button logs.
- Accessibility endpoint returned a populated tree.
- Both MJPEG endpoints returned complete JPEG frames; H.264 returned decoder
  configuration and a keyframe.
- The 3D browser stream reconnected after a server restart and restored the
  guest's primary panel without reloading the page.
- Device Hub input suppression reproduced and repaired; subsequent touches
  reached the guest without restarting backboardd again.

Physical trackpad/touchscreen pinch hardware was not available to the browser
automation API; those event paths were exercised by automated gesture tests.
The full camera/permissions E2E suite is not included in these results.

## Repeating a check

```sh
bun run packages/serve-sim/build.ts
node packages/serve-sim/dist/serve-sim.js --port 3399
node packages/serve-sim/dist/serve-sim.js pose open -d <udid>
node packages/serve-sim/dist/serve-sim.js pose book -d <udid>
xcrun devicectl device motion hinge-angle --device <udid> --timeout 5
xcrun simctl io <udid> enumerate
```

Compare the preview's selected display with the latest SpringBoard
`DisplayContentMode` event containing `.cover:pri` or `.inner:pri`. Repeat after
`pose closed` to test the opposite direction. If input is shadowed, use the
explicit `repair-input` procedure in the package README, then restart serve-sim.
