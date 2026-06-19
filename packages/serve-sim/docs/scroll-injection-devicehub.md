# How Device Hub / Simulator.app forwards scroll to the iOS Simulator

> Reverse-engineered from `SimulatorKit`
> (`/Applications/Xcode-beta.app/Contents/SharedFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit`)
> using Hopper. Addresses below are file offsets in that binary (Xcode 26 beta).
>
> **Status:** findings from static analysis; the "Validation" section tracks what
> has been confirmed against a running simulator.

## TL;DR

Scrolling an iPhone simulator is **not** a synthetic touch digitizer pan. It is a
**host-HID capture** mechanism: SimulatorKit creates a virtual *indirect pointer*
(trackpad) HID service on the guest, taps the Mac's real mouse/trackpad at the
IOKit HID level, and replays each captured `IOHIDEventRef` into the guest as an
Indigo HID message. Real two-finger trackpad scroll → real momentum/inertial
scroll on the device.

The class that owns all of this is **`SimHIDCaptureManager`** (source file
`SimHIDCaptureManager.m`). Device Hub itself contains **zero** scroll code — it
drives `SimDisplayView` / `SimHIDCaptureManager` in SimulatorKit.

## The two input planes

There are two *completely separate* input paths into a booted simulator. Don't
confuse them:

| Plane | Trigger | Indigo message | Use |
|---|---|---|---|
| **Touch digitizer** | clicking/dragging in the canvas (NSEvent) | `_touch_event` | taps, swipes, synthetic pans |
| **Pointer / HID capture** | "Capture pointer" mode, real trackpad/mouse | `_pointer_event`, scroll, trackpad-digitizer | cursor, scroll, magic-mouse |

serve-sim today only uses the **touch digitizer** plane. Scroll lives entirely in
the **pointer/HID-capture** plane.

## Component map (all in SimulatorKit)

```
SimHIDCaptureManager                     ObjC class, SimHIDCaptureManager.m
 ├─ +sharedManager                       @0xdfd8   singleton
 ├─ -startCaptureSessionWithDevice:hidDeviceTypes:error:   sets everything up
 ├─ -stopCaptureSession                  teardown
 ├─ ivars: _mouseSenders / _magicMouseSenders / _trackpadSenders
 │         deviceHIDClient (SimDeviceLegacyHIDClient)
 │         cgEventTap, keyState, escapeKeyCodes, cursorPositionBeforeCapture
 │
 ├─ cgEventTapCallback                   @0xf274-ish   suppressor + escape tracker
 └─ hidEventFilterCallback               @0xf274       THE injection loop

C builders (the Indigo message factory):
  IndigoHIDMessageToCreatePointerService          @0xcbf0   target 0x35
  IndigoHIDMessageToCreateMouseService            @0xccc0   target 0x36
  IndigoHIDMessageToRemovePointerService          @0xcc58
  IndigoHIDMessageToRemoveMouseService            @0xcd28
  IndigoHIDMessageForScrollEventFromHIDEventRef   @0xb6e4   ◀ real scroll
  IndigoHIDMessageForScrollEvent                  @0xb648   synthetic/watch scroll
  IndigoHIDMessageForPointerEventFromHIDEventRef  @0xbf20   cursor move
  IndigoHIDMessageForTrackpadEventFromHIDEventRef @0xc154   trackpad multitouch
  IndigoHIDMessageForTrackpadMoveEvent            @0xbe2c
  IndigoHIDMessageForDigitalCrownEvent            @0xb830   watch crown
  IndigoHIDMessageForDigitalDialEvent             watch dial

transport:
  SimDeviceLegacyHIDClient.send(message:freeWhenDone:completionQueue:completion:)
```

## Lifecycle: `startCaptureSessionWithDevice:hidDeviceTypes:error:`

`hidDeviceTypes` is a bitmask: `0x1` = keyboard, `0x2` = pointer. (Asserts "No HID
types specified" if neither bit is set.)

1. If a session is already running, `stopCaptureSession` first.
2. Create a `SimDeviceLegacyHIDClient` for the target `SimDevice` (on the main
   dispatch queue) — this is the transport to the guest.
3. Build IOHID matching dictionaries keyed on `PrimaryUsagePage` for the device
   classes to capture.
4. **If pointer capture (`0x2`) is requested:**
   - `CGAssociateMouseAndMouseCursorPosition(0)` — decouple the host cursor so the
     Mac pointer stops moving while captured.
   - `[NSCursor hide]`, save `CGSCurrentInputPointerPosition` into
     `cursorPositionBeforeCapture`, then `CGWarpMouseCursorPosition` to a safe
     park point.
   - Send **`IndigoHIDMessageToCreatePointerService`** (target `0x35`) and
     **`IndigoHIDMessageToCreateMouseService`** (target `0x36`) to the guest —
     this *registers the virtual pointer/mouse HID device on the simulator*.
   - OR in the CGEvent tap mask `0xe640001e` (includes bit 22 = `kCGEventScrollWheel`,
     plus mouse-button bits).
5. Parse the escape key combo (default if none set) into a `SimKeyStateTracking`.
6. `CGEventTapCreate(kCGSessionEventTap, …, eventMask, cgEventTapCallback, self)`
   and add it to the main run loop.
7. Enumerate **all** IOHID services via `IOHIDEventSystemClientCopyServices`,
   classify each by `DeviceUsagePage`/`DeviceUsage` + name ("Magic Mouse") into
   `_magicMouseSenders` / `_trackpadSenders` / `_mouseSenders`. These sender-ID
   sets are how the two callbacks know which physical device an event came from.
8. Post `SimHIDCaptureManagerCaptureStartedNotification`.

`stopCaptureSession` reverses it: removes the tap, sends
`IndigoHIDMessageToRemovePointerService` / `…RemoveMouseService`, restores the
cursor (`cursorPositionBeforeCapture`), re-associates mouse + cursor.

## The two callbacks

### `cgEventTapCallback` — suppressor + escape tracker (not the injector)

- Keyboard events (when keyboard capture on): tracks key down/up/flags into
  `knownCGKeyDowns` to detect the escape combo.
- Pointer events (mask `0xe640001e`): `CGEventCopyIOHIDEvent` →
  `IOHIDEventGetSenderID`. If the sender is a device we are already capturing at
  the IOHID level (`_trackpadSenders` / `_mouseSenders` / `_magicMouseSenders`),
  **return `NULL` to swallow the event** so the host doesn't also react. Otherwise
  pass it through. The CGEventTap does **not** build Indigo messages — it only
  gates host delivery + watches for the escape combo.

### `hidEventFilterCallback` — the real injection loop (@0xf274)

Runs per captured `IOHIDEventRef`. Dispatches on `IOHIDEventGetType()`:

| `IOHIDEventGetType()` | builder called | guest target |
|---|---|---|
| `0x3` Keyboard | `IndigoHIDMessageForKeyboardArbitrary` (+ escape via `keyState`) | — |
| `0x11` Pointer | `IndigoHIDMessageForPointerEventFromHIDEventRef` | `0x35` |
| `0xb` Digitizer | `IndigoHIDMessageForTrackpadEventFromHIDEventRef` | `0x35` |
| **`0x6` Scroll** | **`IndigoHIDMessageForScrollEventFromHIDEventRef`** | **`0x35`** |

Each result is sent with
`[deviceHIDClient sendWithMessage:msg freeWhenDone:YES completionQueue:nil completion:nil]`.
If the escape combo fires, it sets `escapeTriggered` and stops forwarding.

So: **physical two-finger scroll → `IOHIDEvent` type `0x6` →
`IndigoHIDMessageForScrollEventFromHIDEventRef(ref, 0x35)` → guest pointer service.**

## Indigo message layouts (validated against disassembly)

The shared `IndigoHIDMessage` header (from the ObjC type encoding):
`{IndigoHIDMessageStruct={?=IIIIIi} I C[…] }` — a 24-byte header, a `uint32` at
`0x18`, then the event payload starting at `0x1c`.

### `IndigoHIDMessageToCreatePointerService` (@0xcbf0) — 192 bytes (`0xc0`)

| offset | value | meaning |
|---|---|---|
| `0x18` | `0xa0` | post-header field |
| `0x1c` | `0x01` (byte) | message kind = create/single-record |
| `0x20` | `0x7fff0001` | control/page id |
| `0x30` | `0x03` | service class (pointer) |
| `0x40` | `0x35` | **IndigoHIDTarget = pointer service** |

`IndigoHIDMessageToCreateMouseService` is identical except `0x30`=`0x05` and
`0x40`=`0x36` (mouse service target).

### `IndigoHIDMessageForScrollEventFromHIDEventRef` (@0xb6e4) — 352 bytes (`0x160`)

Extended two-record format. Pulls live values from the `IOHIDEventRef`:

| offset | source | meaning |
|---|---|---|
| `0x18` | `0xa0` | post-header field |
| `0x1c` | `0x02` (byte) | message kind = event (extended/2-record) |
| `0x20` | `0x11` | record-0 type |
| `0x24` | `mach_absolute_time` → ns | timestamp |
| `0x4c` | `arg1` (`0x35`) | target |
| `0xb1` | `1` (byte) | flag |
| `0xc0` | `0x06` | **record-1 event type = Scroll** |
| `0xc4` | ns timestamp | |
| `0xcc` | `IOHIDEventGetEventFlags` | event flags |
| `0xd4` | `IOHIDEventGetDoubleValue(0x60000)` (double) | **scroll X** |
| `0xdc` | `IOHIDEventGetDoubleValue(0x60001)` (double) | **scroll Y** |
| `0xe4` | `IOHIDEventGetDoubleValue(0x60002)` (double) | **scroll Z** |
| `0xec` | `arg1` (`0x35`) | target |
| `0xf4` | `IOHIDEventGetPhase` | **phase** (began/changed/ended) |
| `0xf8` | `IOHIDEventGetScrollMomentum` | **momentum** (inertial flag) |
| `0x151`| `1` (byte) | flag |

The field selectors `0x60000/0x60001/0x60002` are `(kIOHIDEventTypeScroll(6) << 16) | axis`
= `kIOHIDEventFieldScrollX/Y/Z`.

### `IndigoHIDMessageForScrollEvent` (@0xb648) — synthetic, 192 bytes (`0xc0`)

The simpler "watch / no-IOHIDEvent" variant. Signature
`(uint32 arg0, double dx, double dy, double dz, IndigoHIDTarget target)`:

| offset | value |
|---|---|
| `0x18` | `0xa0` |
| `0x1c` | `0x01` (byte) — single record |
| `0x20` | `0x06` — type Scroll |
| `0x24` | timestamp (`_setTimestamp`) |
| `0x30` | `arg0` |
| `0x34` | `dz` (double) |
| `0x3c` | `dy` (double) |
| `0x44` | `dx` (double) |
| `0x4c` | `target` |

**Key difference:** this synthetic builder carries **no phase and no momentum**.
It is the easiest to reproduce without a real trackpad, but won't reproduce iOS
inertial/momentum scrolling on its own — you'd have to drive phase manually by
sending a sequence (began → changed×N → ended) if iOS requires it.

## Implications for serve-sim

To inject scroll headlessly (no physical trackpad), replicate the capture path's
*output* rather than its input:

1. Once per session, send `IndigoHIDMessageToCreatePointerService` (target `0x35`)
   so the guest has a virtual pointer device.
2. Build scroll messages and send via the `SimDeviceLegacyHIDClient` transport
   (the same channel HIDInjector already uses):
   - **Option A (simple):** hand-build the 192-byte `IndigoHIDMessageForScrollEvent`
     layout with our own deltas + target `0x35`.
   - **Option B (full fidelity):** synthesize an `IOHIDEvent` of type Scroll and
     run it through `IndigoHIDMessageForScrollEventFromHIDEventRef`, or hand-build
     the 352-byte layout including `phase` and `momentum` for inertial scroll.
3. Tear down with `IndigoHIDMessageToRemovePointerService` on session end.

⚠️ See `[[project-hid-injection-broken-xcode26]]`: touch/button HID delivery is
currently being ignored by the iOS 26.5 simulator. The pointer/scroll plane uses
the *same* `SimDeviceLegacyHIDClient` transport, so it may hit the same wall —
**this needs the e2e check below before we invest in an implementation.**

## Validation log

Environment: iPhone 17 Pro, **iOS 27.0**, Xcode 26.6 (17F109). Server:
`node dist/serve-sim.js --port 3399` (local build). Driven via agent-browser +
`simctl io … screenshot`. Settings.app used as the scrollable surface.

### Confirmed against an independent implementation (static)

- ✅ serve-sim's `HIDInjector.swift` already `dlsym`s `IndigoHIDMessageForScrollEvent`
  with the exact signature RE'd here `(UInt32, Double, Double, Double, UInt32)`,
  and uses `SimDeviceLegacyHIDClient` + `sendWithMessage:freeWhenDone:…`. The
  symbol names, transport, and `IndigoHIDMessageForButton` /
  `…KeyboardArbitrary` / `…DigitalCrownEvent` signatures all match the binary.
- ✅ serve-sim's current scroll uses target **`0x32` (display digitizer)** —
  *different* from Device Hub's **`0x35` (pointer service)**.

### Confirmed against a running simulator (behavioral)

- ✅ The browser→server→helper scroll chain fires end to end: a `wheel` over the
  stream sends WS opcode `0x0b` `{dx,dy}` (≈0.27 dy/tick), the server calls
  `hidInjector.sendScroll(dx*W, dy*H)` → `IndigoHIDMessageForScrollEvent(0,…,0x32)`
  → `sendWithMessage`. Verified by hooking `WebSocket.prototype.send` (6/6 frames).
- ❌ **`IndigoHIDMessageForScrollEvent` → digitizer `0x32` does NOT scroll** the
  Settings list. 6 wheel ticks + a CDP `mouse wheel` burst left the view
  byte-identical (only the status-bar clock changed).
- ✅ **Touch-drag swipe DOES scroll** the same view (digitizer touch path,
  `IndigoHIDMessageForMouseNSEvent` → `0x32`): a vertical drag moved Settings
  from "Apple Account…StandBy" down to "Siri…Developer".

**Conclusion:** the failure is *scroll-specific*, not general HID breakage —
taps/drags work on iOS 27.0. The synthetic scroll message reaches the guest but
is ignored. This matches the hypothesis that iOS only accepts scroll on the
**indirect-pointer service (`0x35`)** that must first be created with
`IndigoHIDMessageToCreatePointerService`, the way Device Hub does it — the
digitizer surface (`0x32`) has no scroll concept (it's a touchscreen).

### Implementation attempts — all delivered, none scrolled (iOS 27.0)

Each variant was built into `HIDInjector.swift`, sent without error (helper logs
confirm), and left the Settings view byte-identical:

1. ❌ Synthetic `IndigoHIDMessageForScrollEvent` → target `0x35`.
2. ❌ + `IndigoHIDMessageToCreatePointerService` sent once on session start.
3. ❌ Full path: `IOHIDEventCreateScrollEvent` → `IndigoHIDMessageForScrollEventFromHIDEventRef`
   → `0x35`, with `IOHIDEventSetPhase` began→changed→ended per tick.
4. ❌ + pointer activation via `IndigoHIDMessageForTrackpadMoveEvent` (tried both
   device-pixel center and normalized 0.5,0.5).
5. ❌ Restructured as a **continuous gesture session**: one `began`, a stream of
   `changed` across the wheel burst, `ended` on 120 ms idle (mirrors a real
   trackpad). Still nothing.

### Ground-truth check against Device Hub itself (computer-use)

Opened **Device Hub** showing the same iPhone 17 Pro / iOS 27.0 sim:

- ✅ A synthetic **click** (computer-use `left_click`) on "General" **navigated**
  the sim → Device Hub forwards synthetic taps to the guest.
- ❌ A synthetic **scroll** (computer-use `scroll`, which emits a *discrete,
  line-based* wheel event with no phase/momentum) did **not** scroll — same as
  serve-sim's synthetic attempts.

**Revised conclusion.** The blocker is not the target (`0x35`) or the message
builder — it's event *fidelity*. iOS 27's pointer scroll only commits for a
**continuous, pixel-based, phase+momentum** scroll stream as produced by real
trackpad hardware. Both serve-sim's synthesized `IOHIDEvent` scrolls and
computer-use's discrete wheel events are ignored, even when routed correctly
through the pointer service. Device Hub "works" because `SimHIDCaptureManager`
forwards *genuine* captured `IOHIDEventRef`s (full sender ID, pixel units,
hardware phase/momentum) — fidelity we have not reproduced synthetically.

### Why the pointer path is infeasible for serve-sim (definitive)

`Simulator.app` (and Device Hub, which shares `SimHIDCaptureManager`) is signed
with **private Apple entitlements** that an ad-hoc-signed helper cannot obtain:

```
com.apple.private.hid.client.event-filter     ← receive/filter host HID events
com.apple.private.hid.client.event-monitor
com.apple.private.tcc.allow → kTCCServiceListenEvent, kTCCServicePostEvent
com.apple.private.CoreSimulator.client
```

This was proven empirically: a `--capture-scroll` diagnostic (see
`CaptureScroll.swift`) started a real `SimHIDCaptureManager` session in our own
helper and hooked `sendWithMessage:`. It successfully sent the **create-pointer
(`0x35`)** and **create-mouse (`0x36`)** service messages, but received **zero**
HID events during a real trackpad scroll — without `…hid.client.event-filter`,
the IOHID filter is silently starved. And we can't inject into Device Hub itself
(SIP + `library-validation`).

So Device Hub's scroll fundamentally depends on **privileged host-HID capture**
forwarding genuine hardware events; iOS 27's pointer scroll only accepts those,
and an unprivileged helper can neither capture nor synthesize them.

### Resolution: touch-drag scroll (shipped)

`HIDInjector.sendScroll` translates the wheel delta into a **touch drag** on the
digitizer (`IndigoHIDMessageForMouseNSEvent`, target `0x32`) — the same path
taps/swipes use, which *is* honored on iOS 27. A wheel burst becomes one
continuous drag (begin → moves → end on idle), re-anchoring to center near the
edges so long scrolls aren't capped. **Verified bidirectional** on iPhone 17 Pro
/ iOS 27.0: a wheel-down burst scrolled Settings from "Apple Account…StandBy" to
"Siri…Developer", and wheel-up returned to the top — driven through the real
browser → WS `0x0b` → helper pipeline.

This is also the *correct* model for a touchscreen device: there is no hardware
scroll wheel; scrolling is a finger drag.

**Cursor-anchored.** The drag begins under the pointer (the wheel event's cursor
position, sent as normalized `x`/`y` in `ScrollEventPayload` and rotated to raw
device orientation alongside the delta), so iOS hit-tests the view beneath the
cursor — e.g. scrolling over Apple Maps' bottom sheet pans the sheet, while
scrolling over the map pans the map. Verified: a wheel over the map region
(anchor y≈0.25) panned San Francisco → Pigeon Point; a wheel over the sheet
(anchor y≈0.78) left the map untouched. Edge re-anchoring returns to the cursor
anchor (not center) so long scrolls keep hit-testing the same view.

The `--capture-scroll <udid> [seconds]` subcommand is retained as a diagnostic
(useful if run from a binary that ever gains the HID entitlements).
```
