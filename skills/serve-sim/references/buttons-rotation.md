# Buttons and rotation reference

## Contents

- Valid button names
- Button behavior details
- Valid orientations
- Rotation gotchas

## Valid button names

These are the **only** values accepted by `npx serve-sim button <name>`. Anything else prints `[hid] Unknown button: <name>` and does nothing.

| Name | Effect |
|---|---|
| `home` | Single Home button press (down + up). Falls back to launching SpringBoard via `simctl launch` if the HID symbol is not available. |
| `swipe_home` | Synthesizes a swipe-up-from-bottom gesture with `edge=3` — the canonical "go home" gesture on Face ID devices. Use this on iPhone X+ and modern iPads. |
| `app_switcher` | Double Home press with a 150ms delay between presses. Opens the multitasking switcher. Requires the HID symbol. |
| `lock` | Power / Sleep button press (down + up). Locks the device. |
| `siri` | Holds the side button for ~300ms. A tap is ignored — the simulator only recognizes the long-press for Siri invocation. |
| `side_button` | Single side-button press (down + up). On modern iPhones this is the wake/sleep button; double-click invokes Apple Pay. |

## Button behavior details

### `home` vs `swipe_home`

- Devices with a physical Home button (iPhone SE, classic iPad layouts): use `home`.
- Face ID devices (iPhone X and later, modern iPads): both work, but `swipe_home` matches the gesture a real user performs and exercises iOS's edge-gesture recognizer. Use `swipe_home` for fidelity with real-user behavior.

### `siri` requires the hold

Tapping the side button briefly does **not** trigger Siri. The CLI command holds for 300ms automatically — you do not need to script it.

### `app_switcher` availability

`app_switcher` depends on the `IndigoHIDMessageForButton` symbol being resolvable in the simulator's private framework. If the simulator was launched from an older Xcode, the command may log `App switcher not available` and do nothing. Fall back to a `gesture` that swipes up to the middle of the screen and pauses, then continues — but this is fragile across iOS versions.

### Lock screen capture

A common test pattern: `lock` → wait → `lock` again wakes the device into the lock screen, which is useful for testing widget and lock-screen UI.

## Valid orientations

These are the **only** values accepted by `npx serve-sim rotate <orientation>`:

| Value | Description |
|---|---|
| `portrait` | Home indicator / Home button at the bottom |
| `portrait_upside_down` | Home indicator at the top |
| `landscape_left` | Device rotated so its right side is up; status bar on the left |
| `landscape_right` | Device rotated so its left side is up; status bar on the right |

These correspond to `UIDeviceOrientation` values 1, 2, 4, and 3 respectively in iOS's internal enum.

## Rotation gotchas

- **`portrait_upside_down` is not honored by many apps.** Apple's HIG discourages it, and most apps lock orientation in their `Info.plist`. The simulator dispatches the event regardless, but the app may not visibly rotate.
- **`landscape_*` requires app support.** If the target app declares `UISupportedInterfaceOrientations = ["UIInterfaceOrientationPortrait"]` only, the device rotates internally but the app keeps its portrait layout.
- **Apple Watch does not rotate.** Sending `rotate` to a watchOS simulator has no effect.
- **Touch coordinates auto-compensate after rotation.** The serve-sim client tracks the last-set orientation and rotates incoming `x`/`y` from "logical display" to "raw HID" coordinates. You can continue to think in `(0,0) = top-left` of the screen as the user sees it, regardless of orientation.
- **Simulator.app must be running** for `rotate` to work. The orientation event is delivered via Mach IPC through `PurpleWorkspacePort`, which only exists when Simulator.app is attached to the device. A pure-headless `xcrun simctl boot` without Simulator.app cannot receive the rotation event — the CLI will print a warning and return non-zero.
