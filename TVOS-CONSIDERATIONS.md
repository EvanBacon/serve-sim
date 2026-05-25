# Plan: Apple TV (tvOS) Simulator Support in `serve-sim`

## 1. Current state

`serve-sim` already streams an iOS simulator over MJPEG and forwards taps/keys/buttons through a WebSocket protocol. tvOS is explicitly excluded in two places — everything else is generic enough to extend.

**Hard exclusions today:**
- `packages/serve-sim/src/middleware.ts:508` — runtime allowlist regex `/SimRuntime\.(iOS|watchOS|visionOS|xrOS)-/i` drops tvOS. Comment at :507 calls it out as intentional.
- `packages/serve-sim/src/device.ts:18` — `findBootedDevice()` prefers iOS; tvOS only used as fallback.

**Touches tvOS but doesn't classify it:**
- `packages/serve-sim/src/client/utils/devices.ts:28-44` — `deviceKind` / `runtimeOrder` have iPhone/iPad/Watch/Vision; tvOS falls into the catch-all "4" bucket.
- `packages/serve-sim-client/src/simulator/deviceFrames.tsx:12-21` — `DeviceType` union and `getDeviceType()` lack `"tv"`.
- `packages/serve-sim-client/src/simulator/deviceFrames.tsx:42-81` — `SIMULATOR_SCREENS` table has no Apple TV entry.

**Generic / portable today:**
- WebSocket input protocol (`Sources/SimStreamHelper/Protocol.swift`) — opcodes `touch`/`button`/`key`/`multiTouch` are name-keyed JSON, trivially extensible.
- `FrameCapture.swift` reads the largest live IOSurface on `com.apple.framebuffer.display` — that mechanism is the same on tvOS.
- `AccessibilityBridge.swift` uses `AccessibilityPlatformTranslation.framework`, which is platform-agnostic.

---

## 2. Design choices to settle before coding

These are real forks in the road, not implementation details.

**A. Siri-remote input transport.** Three options, ranked:
1. **USB HID Keyboard (Usage Page 0x07) via the existing `sendKey` path** — arrow keys (0x4F–0x52), Return (0x28), Escape (0x29) drive the tvOS focus engine natively. Lowest-risk, reuses `HIDInjector.sendKey()` (`HIDInjector.swift:226`).
2. **HID Consumer Page (0x0C) buttons for media keys** — Play/Pause (0xCD), Mute, etc. Requires a new `IndigoHIDMessageForConsumerKey`-style binding; may not exist. Investigate at build time.
3. **Touchpad swipe simulation via touch events** — for the click-pad feel. Probably overkill for v1; the focus engine already responds to arrow keys.

Recommend (1) for v1, with (3) as a follow-up if real Siri remote swipe semantics matter.

**B. Frame chrome.** Apple TV has no device bezel to render — it outputs to a TV. Two reasonable approaches:
- **No chrome / fill mode** — render the 1920×1080 (or 3840×2160) stream into the panel with letterboxing only. Simplest.
- **TV bezel mockup** — draw a stylized TV frame around the stream. Cosmetic; skip for v1.

Recommend the no-chrome fill mode.

**C. CLI surface for remote buttons.** The existing `serve-sim button <name>` (`src/index.ts:1029`) ships a `{button: "..."}` JSON over opcode `0x04`. Extending it with `up`/`down`/`left`/`right`/`select`/`menu`/`play_pause` keeps the API uniform. Alternatively add `serve-sim remote <direction>`. Recommend extending `button` — fewer concepts.

**D. Should `findBootedDevice()` ever return a tvOS device by default?** No — keep iOS-first behavior to avoid surprising existing users. Require explicit `-d <udid>` or a new flag (or runtime preference) to target tvOS.

---

## 3. Phased implementation plan

### Phase 1 — Enumeration unlock (small, low-risk)

Goal: tvOS sims appear in the device picker and can be selected.

- `packages/serve-sim/src/middleware.ts:508` — extend regex to `/SimRuntime\.(iOS|watchOS|visionOS|xrOS|tvOS)-/i`. Update the comment at :507.
- `packages/serve-sim/src/client/utils/devices.ts:28-44` — add `"appletv"` / `"apple tv"` to `deviceKind` (return 4, shift others) and `"tvos"` to `runtimeOrder`.
- `packages/serve-sim-client/src/simulator/deviceFrames.tsx:12-21` — extend `DeviceType` union to `"iphone" | "ipad" | "watch" | "vision" | "tv"`; update `getDeviceType()` to detect "tv" / "apple tv".
- `packages/serve-sim-client/src/simulator/deviceFrames.tsx:42-81` — add Apple TV entries (1920×1080 for non-4K, 3840×2160 for 4K) to `SIMULATOR_SCREENS`. Add a `DEVICE_FRAMES.tv` entry with zero bezels (fill mode).
- `packages/serve-sim/src/device.ts:8-25` — leave `findBootedDevice()` iOS-first, but extend the doc comment to mention tvOS is now reachable via explicit selection.

**Done when:** `xcrun simctl boot <tvos-udid>` followed by loading the web UI shows the Apple TV in the picker and streams its framebuffer.

### Phase 2 — Siri remote input via keyboard HID

Goal: arrow / select / menu drive the tvOS focus engine.

- `packages/serve-sim/Sources/SimStreamHelper/HIDInjector.swift:288-341` — in `sendButton`, add `case "remote_up"`, `"remote_down"`, `"remote_left"`, `"remote_right"`, `"remote_select"`, `"remote_menu"`, `"remote_play_pause"`. Each calls the existing `sendKey()` with the corresponding HID usage:
  - up=0x52, down=0x51, left=0x50, right=0x4F (Keyboard arrows)
  - select=0x28 (Return), menu=0x29 (Escape)
  - play_pause: try `sendKey` with usage 0xE8 first; if that no-ops on the sim, route through a consumer-page binding (Phase 2b).
- `packages/serve-sim/src/index.ts` (CLI) — no code change needed; `serve-sim button remote_up` works through the existing `{button: name}` envelope at :1041.
- Document the new button names in README.
- Client UI: in `packages/serve-sim-client/src/simulator/SimulatorView.tsx`, add a keyboard handler active only when `getDeviceType() === "tv"` that maps `ArrowUp/Down/Left/Right/Enter/Escape` to `sendButton("remote_*")`. (Mouse clicks have no useful tvOS analog; suppress them.)

**Done when:** focus moves around a tvOS app via both the CLI (`serve-sim button remote_right`) and the browser arrow keys.

### Phase 3 — Onscreen remote control (optional polish)

A small floating remote in the panel so users don't need to remember keys. Buttons map to the same `sendButton("remote_*")` calls. Render only when `getDeviceType() === "tv"`. Skip for v1 if scope is tight.

### Phase 4 — Camera / AX / permissions sanity check

- Camera dylib injection (`Sources/SimCameraInjector/`) — tvOS apps rarely use `AVCaptureDevice`. Don't actively support; verify it doesn't crash if injected by accident. Add a guard in the CLI camera command to refuse tvOS targets with a friendly message.
- Accessibility bridge — should work unchanged. Spot-check on a booted tvOS sim: `curl http://localhost:3399/ax` should return a non-empty tree.
- Permissions (`src/__tests__/permissions.e2e.test.ts:20-37`) — leave iOS-only; the TCC layout differs on tvOS. Document the gap in the test file's existing comment.

### Phase 5 — Tests & docs

- Add a unit test in `src/__tests__/multi-device.test.ts` (or sibling) confirming tvOS runtimes are now surfaced from a `simctl list devices` fixture.
- Add a test in `packages/serve-sim-client/src/__tests__/` covering `getDeviceType("Apple TV 4K (3rd generation)") === "tv"`.
- Update `packages/serve-sim/README.md` and the project `CLAUDE.md` E2E section with a tvOS example (`serve-sim button remote_right`).

---

## 4. Risks / open questions

- **HID consumer-page availability.** If `IndigoHIDMessageForKeyboardArbitrary` rejects media keys on the tvOS sim, Play/Pause needs a second binding. Worth a quick probe before committing to Phase 2.
- **Frame-capture surface selection.** `FrameCapture.swift:141-151` picks the largest live IOSurface. On a 4K Apple TV sim, that surface is much larger than any iPhone — confirm the H.264 encoder pipeline handles 3840×2160 without dropping frames. May need a resolution clamp.
- **Aspect-ratio assumption.** `simulatorAspectRatio()` falls back to iPhone dimensions when no `SIMULATOR_SCREENS` entry is found (`deviceFrames.tsx:92`). Make sure Phase 1 adds tvOS entries before the picker can land on tvOS — otherwise the stream is letterboxed wrong.
- **`-d <name>` UDID resolution.** `resolveDevice()` in `src/device.ts:32-49` matches names case-insensitively across all runtimes — already works for tvOS, but verify two sims with the same name (e.g., "Apple TV 4K" in two runtimes) don't collide.
