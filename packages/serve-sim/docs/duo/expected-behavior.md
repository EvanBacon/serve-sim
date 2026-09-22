# iPhone Duo feature contract and regression checklist

Updated September 21, 2026. These are the expected behaviors to preserve when
changing rendering, capture, gestures, hardware controls, or toolbar layout.
Use [verification.md](verification.md) for historical validation; its earlier
2D-mode descriptions and instant-angle matrix do not define the current UI.

## Model and screen rendering

- [ ] Duo has one interactive 3D preview. There is no flat-preview mode or 3D
  toggle. Single-display devices retain their existing preview.
- [ ] Use the installed Xcode V68 device model, with a neutral gray shell and
  restrained highlights. The body should not turn glossy or disappear into black.
  Apple assets remain in Xcode and are not redistributed.
- [ ] Screen whites, grays, and saturated colors match the simulator framebuffer.
  Avoid the dark, oversaturated result caused by interpreting linear Display P3
  render output as sRGB. Known solid color patches matched within one RGB value
  in the local export check.
- [ ] The device fills the available preview area without clipping its body,
  hardware controls, or toolbar. Check narrow/wide windows and open side panels.
- [ ] The camera has restrained perspective, resembling Device Hub. The 130°
  book pose is centered around its hinge with equal left/right foreshortening.
- [ ] The background around the device stays transparent.
- [ ] Fine UI text is sharp after motion settles. Current targets are 1500×1350
  during activity and 3000×2700 after about 180 ms idle. Switching targets must
  not change framing, touch coordinates, or count as a new pose animation.
- [ ] The simulator surface cannot be text-selected or image-dragged by the
  browser. Clicking, dragging, and pinching still reach the simulator.

## Folding and rotation

- [ ] Folded (0°), semi-folded (130°), and fully open (180°) presets work. Holding
  Alt exposes the continuous hinge slider.
- [ ] Pinch must not change the hinge angle. Folding is controlled by pose
  buttons or the Alt slider; two-finger screen input remains available to apps.
- [ ] Folding/unfolding does not introduce an unrelated 90°/180° flip when the
  guest changes orientation or switches the active display. The fold's camera
  centering remains continuous; the closed cover faces the viewer.
- [ ] Rotate works on a static screen in all four orientations. The model
  animates along the shortest turn, rather than snapping or taking a long spin.
  Current rotation duration is approximately 300 ms. The same action changes
  the guest's physical orientation through the Duo vendor HID orientation event;
  it must rotate the app UI as well as the rendered model, in the matching
  direction so screen content stays upright after either quarter-turn. The
  screen/UI landscape names map to the opposite CoreDevice physical names.
  Check closed, book,
  and open poses. Guest UI orientation comes from panel readback, not the model
  target (the inner panel's natural axis differs from the cover).
  With Safari foreground, run `bun packages/serve-sim/scripts/verify-duo-rotation.ts <udid> [port]`
  to verify all four physical orientations and app UI rotation in all three poses.
  Apps retain their supported-orientation policy: for example, Safari excludes
  upside-down portrait on the cover, and Settings stays portrait on the cover.
- [ ] Repeated rotation requests can retarget an in-progress rotation. Rejected
  HID commands do not change the confirmed orientation.
- [ ] All three fold-state toolbar icons rotate with the device and animate to
  their new orientation. Selection remains attached to the current fold pose.
- [ ] Touches map to the correct location on both bent screen halves, including
  after rotation and resolution changes. Hardware controls do not send screen taps.
- [ ] Swipe-to-home works on cover and inner displays in every orientation.
  Detect the home edge in guest framebuffer coordinates and preserve its edge
  marker through begin, move, release, and cancellation.
- [ ] Capture follows the guest's active panel, not just an angle threshold.
  Check closed → book → open → book → closed and changes made in Device Hub.

## Hardware controls

- [ ] Power/lock and camera controls are positioned outside their physical device
  edge. Volume down/up sit outside the volume-button edge, above it at the
  default orientation. There are no volume controls in the main control bar.
- [ ] Each control position follows the projected physical edge in all four
  orientations, on both cover and inner displays. Do not anchor them to the
  viewport's axis-aligned right/top bounds. Icons and tooltips stay upright,
  including when the device is upside down. Open sidebars must not cover them.
- [ ] On a mouse/trackpad, nearby cursor movement reveals controls with a fade;
  moving away hides them. Visible icons have normal contrast.
- [ ] Controls stay hidden and noninteractive during fold/rotation movement,
  including when the pointer or keyboard focus was already near them. Current
  reveal eligibility resumes about 220 ms after the last pose change.
- [ ] Keyboard focus can reveal controls; touch devices can access them without
  hover once the model settles. Press-and-hold, release, cancellation, and
  unmount release do not leave a hardware key held down.

## Accessibility inspection

- [ ] Enabling AX Tree shows interactive element highlights on Duo as well as
  the sidebar tree. Hover and selection stay synchronized.
- [ ] Highlights follow the projected screen surfaces. V68 AX coordinates are
  native portrait points at 3× scale; normalize against the active framebuffer,
  not the app root (which can retain cover dimensions on the inner display).
  Do not apply guest orientation a second time. Read the model's animated joint
  transforms when projecting screen planes; a flat-bounds/ideal-hinge
  approximation drifts on partially folded displays.
  Elements crossing the hinge split across both leaves rather than spanning the
  fold as a flat rectangle. Inspection clicks do not become guest screen taps.

## Connection and screenshots

- [ ] The status pill becomes live when the 3D stream delivers frames. A working
  device must not remain labeled connecting. A broken stream retries and updates
  status; reconnecting restores the current model and active display.
- [ ] Screenshot captures the active app framebuffer, not the rendered shell.
  An unfolded device must not produce a black image from its inactive cover.
- [ ] Capture selects `primary-1` for the inner display and `primary` for the
  cover. Rotate either panel and repeat the capture. Single-display devices keep
  their default capture behavior.
- [ ] Screenshot success feedback, thumbnail, reveal-in-Finder, and drag-to-import
  continue to work.

## Repeatable regression pass

1. Rebuild with `bun run packages/serve-sim/build.ts`. Restart the running server
   after native changes; use the rebuilt local CLI, not a global/npx package.
2. Open the preview and confirm live status, neutral shell, accurate screen
   colors, useful sizing, and no browser selection highlight while dragging.
3. Run the fold sequence above in both directions. Check book symmetry and that
   active-display changes never spin the model.
4. Rotate through all four orientations on a static screen and during motion.
   Check toolbar icons, hidden controls, final control locations, and touch taps.
5. Scroll an app, then stop. Check responsive motion and the return to sharp text
   without a size jump. Resize the browser and open/close its side panels.
6. Hover near each physical button edge, move away, hold/release each control,
   and begin a fold while hovering. Repeat after rotation and on the cover.
7. Screenshot inner and cover in portrait and landscape. Inspect the saved PNGs
   for actual app content, dimensions, and colors; do not accept exit code alone.
8. Restart the server with the preview open and verify stream recovery.

Relevant automated suites in `src/__tests__`:

| Area | Suites |
| --- | --- |
| One-mode preview and pose toolbar | `duo-preview.test.ts`, `device-hinge-controls.test.tsx` |
| Physical anchors, rotation, pose identity | `duo-controls-position.test.ts` |
| Bent-screen touch mapping | `duo-projection.test.ts`, `duo-ax-frame.test.ts`, `duo-home-gesture.test.ts` |
| Static-frame redraw, rotation interpolation, idle sharpening, lifecycle | `device-session-lifecycle.test.ts` |
| Panel selection and screenshots | `device-displays.test.ts`, `screenshot-toast.test.tsx` |
| Stream framing | `mjpeg-frame-parser.test.ts` |

Run typecheck and lint too. Unit tests do not replace visual checks for color,
framing, animation smoothness, hover fades, or actual guest screenshot content.

## Known limits and implementation reference

The PNG rendering pipeline remains slower than Device Hub's native composition.
Local benchmarks improved from roughly 11–12 fps at full resolution to around
20 fps during motion. This is a measured limitation, not a desired frame-rate
cap or a claim of Device Hub-equivalent smoothness. Retain idle sharpness while
improving performance; remeasure after renderer changes. Retain per-panel screen
textures and skip decoding/uploading unchanged frames during pose animation. A
subsequent cached-frame benchmark measured roughly 19 ms per frame, versus
about 48 ms before reuse. Changing app content and moving poses can cost more;
this is not a measured end-to-end browser frame rate.

Device Hub uses a perspective camera, not a confirmed orthographic camera.
Hopper inspection found an adjustable focal length and a 36 mm sensor model.
Our current 200 mm lens is chosen for the flatter appearance; it is not a claim
that Device Hub always uses 200 mm. Camera and touch projection must use the
same field of view.

The shell material table and object lighting were inspected in Xcode 27.1's
CoreDevicePopDeviceKitExtension. These private interfaces, material names, and
screen device names must be rechecked after Xcode/runtime updates.

Performance follow-up: fast lossless PNG export and retained screen textures
measured about 15 ms per cached frame locally. Rotation-only frames use one
render pass; hinge changes still allow skinning to settle. Under HTTP backpressure,
skip obsolete frames instead of building an animation queue. These timings exclude
browser decoding and are not a claim of sustained 60 fps for changing app content.

The native encoder round-trip test can be run from the repository root:

```sh
xcrun swiftc -O -parse-as-library packages/serve-sim/Sources/SimDuoRenderer/FastPNG.swift packages/serve-sim/Sources/SimDuoRenderer/Tests/FastPNGTests.swift -o /tmp/serve-sim-fast-png-tests
/tmp/serve-sim-fast-png-tests
```

To check the projection against rendered pixels (requires Pillow):

```sh
python3 packages/serve-sim/scripts/verify-duo-projection.py
```

This renders colored markers on both inner leaves at 100°, 130°, 170°, and 180°,
and on the closed cover, in all four rotations. Projected marker centers must
land within two output pixels of their rendered centers at 1500×1350.
