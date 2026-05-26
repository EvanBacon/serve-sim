# serve-sim for Apple TV (tvOS)

The `npx serve` of Apple TV simulators.

Drive a booted tvOS simulator from the browser or the CLI — focus navigation, the Siri remote's discrete buttons, long presses, and text input all over the same MJPEG stream + WebSocket channel that powers the iOS preview.

```sh
npx serve-sim --tv
# → Preview at http://localhost:3200
```

tvOS support is opt-in via a top-level `--tv` flag. Apple TV simulators don't share much input surface with iOS (no touchscreen, different button transports), so `serve-sim`'s iOS-default behaviors stay iOS-only unless `--tv` is passed.

## Features

- Full streamed preview of the 1080p Apple TV framebuffer.
- Siri remote: directional pad, select, menu, the round Apple TV / Home button, play/pause, volume, Siri.
- Long-press support (`--hold [ms]`) for the buttons that have a discrete tvOS long-press gesture.
- Web-preview keyboard: arrows + Enter + Escape + media keys drive the remote; every other key types into the focused tvOS text field.
- Same `serve-sim type "..."` CLI as iOS, for scripted text input.
- 4K-at-native-resolution sims auto-filtered to keep the encoder happy.

## Quick start

1. Boot an Apple TV simulator (Xcode → Open Developer Tool → Simulator, or `xcrun simctl boot "Apple TV (3rd generation)"` etc.).
2. Start serve-sim with `--tv`:

   ```sh
   npx serve-sim --tv                  # foreground preview at http://localhost:3200
   npx serve-sim --tv --detach -q      # background daemon; returns JSON
   npx serve-sim --tv -d "Apple TV"    # pin a specific tvOS device
   ```

3. Open the preview URL in your browser, or drive the sim from the CLI.

When auto-selecting, `--tv` prefers a 1080p Apple TV sim and skips full-resolution 4K variants — the 3840×2160 framebuffer chokes the H.264 encoder. The "(at 1080p)" 4K sims are kept because they output a 1080p framebuffer. Pass `-d <name>` to override.

Without `--tv`, `findBootedDevice()` still prefers an iOS sim, so existing iOS workflows are unaffected.

## Siri-remote buttons

```sh
serve-sim button <name> [--hold [ms]] [-d udid]
```

| Name | Effect | Transport |
|---|---|---|
| `remote_up` / `remote_down` / `remote_left` / `remote_right` | Move focus one cell. | Keyboard HID (arrows 0x52 / 0x51 / 0x50 / 0x4F) |
| `remote_select` | Confirm focused item. Equivalent to clicking the Siri-remote touchpad. | Keyboard HID (Return, 0x28) |
| `remote_menu` | Step one screen back. | Consumer Page (Menu Escape, 0x46) |
| `remote_tv` | Round "Apple TV" / Home button — return to home screen. | Consumer Page (AC Home, 0x223) |
| `remote_play_pause` | Toggle video playback. | Consumer Page (Play/Pause, 0xCD) |
| `remote_volume_up` / `remote_volume_down` | Volume — accepted but the tvOS sim doesn't model speaker volume. | Consumer Page (0xE9 / 0xEA) |
| `remote_siri` | Open the voice-command UI. | Consumer Page (Voice Command, 0xCF) |

### Why two transports

Directional keys + `remote_select` ride the **keyboard** HID path because tvOS's focus engine listens to USB-HID keyboard events natively. The discrete remote buttons (`menu`, `tv`, `play_pause`, `volume_*`, `siri`) go through `IndigoHIDMessageForHIDArbitrary` on the **Consumer Page** with target `0x15` (the tvOS remote routing target).

### Long press

`--hold [ms]` holds the press for `ms` (default `1500`) before releasing. Honored only by the buttons with a discrete tvOS long-press gesture; every other button silently ignores it.

| Button | Long-press effect |
|---|---|
| `remote_select` | Focus context menu / wiggle mode |
| `remote_play_pause` | Older Siri-remote sleep gesture and some app-specific behaviors |
| `remote_menu` | Jump to the home screen instead of stepping one screen back |

```sh
serve-sim button remote_select --hold        # 1500ms hold
serve-sim button remote_play_pause --hold 800
```

## Web preview controls

When the preview is showing a tvOS sim, these keys map to Siri-remote events:

| Key | Sends |
|---|---|
| Arrow keys | `remote_up` / `down` / `left` / `right` |
| Enter / Return | `remote_select` |
| Escape | `remote_menu` |
| `PlayPause` (Mac media key) | `remote_play_pause` |
| `AppleTV` | `remote_tv` |

Every other key (letters, digits, Space, Backspace, Tab, …) is forwarded as a USB HID keyboard event, so it lands in whatever text field has focus on the sim — the on-screen keyboard in Settings, account fields, search bars, etc.

Mouse/touch forwarding on the stream surface is turned off automatically for tvOS. Apple TV has no touchscreen, and clicks were being interpreted by the helper's mouse-NSEvent path and bouncing the sim back to the home screen.

## Typing text

Both paths reach a focused text field on tvOS:

- The web preview forwards every non-navigation key as a USB HID keystroke.
- `serve-sim type "..."` sends the same keystrokes from the CLI without needing the browser:

  ```sh
  serve-sim type "hello world"
  echo "from stdin" | serve-sim type --stdin
  serve-sim type --file ./snippet.txt
  ```

If a text field is **not** focused, the keystrokes still arrive at the helper but tvOS has nowhere to route them — navigate focus to the field with the remote buttons first.

## End-to-end example

```sh
# 1. Confirm a tvOS sim is booted
xcrun simctl list devices booted | grep -i "Apple TV"

# 2. Start serve-sim with --tv
URL=$(npx serve-sim --tv --detach -q | jq -r '.url')
echo "preview: $URL"

# 3. Open the app you want to drive
xcrun simctl launch booted com.acme.media

# 4. Navigate with the remote
serve-sim button remote_down
serve-sim button remote_right
serve-sim button remote_select

# 5. Toggle playback or go home
serve-sim button remote_play_pause
serve-sim button remote_tv

# 6. Type into a focused text field
serve-sim type "search query"

# 7. Long-press for context menus / wiggle mode
serve-sim button remote_select --hold

# 8. Read the accessibility tree (works on tvOS)
curl -s http://localhost:3100/ax | jq '.children[0].AXLabel'

# 9. Cleanup
serve-sim --kill
```

## What doesn't work on tvOS

- **`serve-sim tap` and `serve-sim gesture`** — no touchscreen on Apple TV.
- **iOS hardware buttons** (`home`, `swipe_home`, `app_switcher`, `lock`, `siri`, `side_button`) — they target iOS hardware buttons. Use `remote_tv` for home and `remote_siri` for Siri.
- **`serve-sim rotate`** — Apple TV is always landscape.
- **`serve-sim camera <bundle-id>`** — camera injection isn't supported on tvOS. tvOS apps rarely use AVFoundation, and the dylib injection path was validated against iOS sims only.
- **`serve-sim permissions`** — the TCC database schema and push-notification state layout on tvOS differ from iOS. The subcommand was tested only against iOS.
- **`remote_volume_up` / `remote_volume_down`** — the keystroke lands but the tvOS sim doesn't model speaker volume, so the press is a no-op.

## How it works

```text
┌──────────────┐   simctl io   ┌─────────────────┐  MJPEG / WS  ┌─────────┐
│ tvOS Simulator│ ──────────►  │ serve-sim-bin   │ ───────────► │ Browser │
│  (1080p)      │   (Swift)    │ (per-device)    │              └─────────┘
└──────────────┘               └─────────────────┘
                                       ▲
                                  state file in
                                $TMPDIR/serve-sim/
                                       ▲
                               ┌──────────────────┐
                               │ serve-sim CLI    │
                               └──────────────────┘
```

The same Swift helper drives every Apple simulator family. tvOS-specific input is layered on:

- Button cases for `remote_*` in `HIDInjector.sendButton`.
- A `pressConsumer(usage:)` helper that calls `IndigoHIDMessageForHIDArbitrary(target=0x15, usagePage=0x0C, usage, direction)` — the only transport that dispatches per-button Siri-remote events into the sim.
- `--hold` support: the press / sleep / release sequence runs on a dedicated dispatch queue so the WebSocket handler thread isn't blocked.

## See also

- [README.md](README.md) — full serve-sim documentation, iOS-focused.
- [`skills/serve-sim/SKILL.md`](skills/serve-sim/SKILL.md) — agent-facing skill, with a dedicated "Apple TV (tvOS) support" section.
- [`skills/serve-sim/references/buttons-rotation.md`](skills/serve-sim/references/buttons-rotation.md) — source-of-truth button vocabulary.
- [`skills/serve-sim/references/workflows.md`](skills/serve-sim/references/workflows.md) — Workflow 8 is the end-to-end tvOS recipe.
