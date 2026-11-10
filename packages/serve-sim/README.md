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
- Recent simulator actions are available in the browser tools panel and `serve-sim event-log`.
- Drag and drop videos and images to add them to the simulator device.
- Keyboard commands and hot keys are forwarded to the simulator, including CMD+SHIFT+H to go home.
- Apple Watch, iPad, and iOS support.

## Why?

Hosted simulators can be hard to test, `serve-sim` enables you to test the hosted infra locally first for faster iteration. When you're ready to host a simulator remotely, simply tunnel the served URL and users can interact with the simulator as if it were running locally on their device.

I develop the Expo framework, but this tool is completely agnostic to React Native and can be used for any iOS interaction you need.

## Install

Requires macOS with Xcode command line tools (`xcrun simctl`) and a [maintained Node.js LTS release](https://nodejs.org/en/about/previous-releases) (currently Node 20+). Older or end-of-life Node versions are not supported. `bun` is **not** required to run the CLI. Camera injection uses a host-side helper built for macOS 14+.

> **Note:** Apple Silicon (arm64) only. The bundled `serve-sim-bin` helper ships as an arm64 binary and does not run on Intel (x86_64) Macs.

> **Xcode 27 keyboard input:** Device Hub must be running with the target simulator window visible and frontmost. macOS may also require the app that launched `serve-sim` (for example Terminal) to be enabled in **System Settings → Privacy & Security → Accessibility**. Xcode 26 and older keep using the legacy simulator HID path. Set `SERVE_SIM_DISABLE_DEVICE_HUB_KEYBOARD=1` to opt out of the Xcode 27 bridge.

## iPhone Duo

With Xcode 27.1 and the iOS 27.1 runtime, the preview exposes **Closed**,
**Book**, and **Open** controls for iPhone Duo. Selecting one drives
the simulator's hinge and follows the active panel's framebuffer. Touches use the panel's own
integrated digitizer; volume and power controls use a guest HID service.

```sh
serve-sim fold 0 -d <udid>
serve-sim fold 180 -d <udid>      # flat, 180°
serve-sim fold 130 -d <udid>      # 130°
serve-sim fold 100 -d <udid>
```

Commands wait for the guest to acknowledge dispatch. Invalid angles and failed
commands do not change capture. The bundled `simduo/serve-sim-duo-hid` executable
runs inside the simulator and exits with the device session. Its `watch-angle` mode
reads the hinge angle inside the simulator from CoreMotion, so it doesn't depend on
`devicectl`. That is how the preview learns the current angle and follows Device Hub.

Duo uses one interactive RealityKit preview of the installed Xcode model, with
live screen textures and touches mapped to each bent screen half. Apple's model
stays in Xcode; it is not redistributed. Rotate animates the device and pose
icons together. Motion uses a faster 1000×900 render target and sharpens once to 1500×1350 when settled.
Screenshots capture the active app framebuffer, including the unfolded inner display.

Use the pose buttons or hold **Alt** to reveal the continuous hinge slider.
Pinch gestures do not fold the device.
Power, camera, and volume controls follow the device's physical edges, fade in
when the cursor is nearby, and stay hidden during pose animation. They support
press-and-hold. The main control bar has no volume menu or 2D/3D mode toggle.

See the [feature contract and regression checklist](../../.agents/skills/serve-sim-duo-verification/references/expected-behavior.md)
for appearance, folding, rotation, controls, screenshot, and performance checks.

The preview follows hinge changes made in Device Hub. The pose toolbar offers
exactly three presets: Closed (0°), Book (130°), and Open (180°). Set any other
angle with `serve-sim fold <deg>`; use Rotate for orientation. SpringBoard primary-display events choose the captured panel,
including intermediate poses that depend on whether you were opening or closing.
Until guest readback arrives, a 90° threshold provides the initial fallback.
The runtime decides which intermediate poses apps adopt.

Xcode 27 Device Hub can disconnect legacy touch/keyboard services. If input
stops working, run `serve-sim repair-input -d <udid>`. **This restarts SpringBoard
and closes running apps.** Restart serve-sim afterward to reconnect guest HID
services, then reopen your app. This repair is explicit, never automatic.

If Device Hub is stuck on “Connecting display…” and `xcrun simctl io <udid>
enumerate` lists no framebuffer ports, streaming cannot start until the simulator's
display connection is restored. Duo relies on private beta APIs and the selected
Xcode's `V68.usdz` model; compatibility must be rechecked after SDK updates.

## CLI

```
serve-sim [device...]                 Start preview server (default: localhost:3200)
serve-sim --no-preview [device...]    Stream in foreground without a preview server
serve-sim gesture '<json>' [-d udid]  Send a touch gesture
serve-sim button [name] [-d udid]     Send a button press (default: home)
serve-sim type <text> [-d udid]       Type text via the simulator keyboard
                                      (US keyboard only; also --stdin / --file <path>)
serve-sim paste <text> [-d udid]      Paste any Unicode text: stage it on the guest
                                      pasteboard (devicectl, verified by readback),
                                      then Cmd+V (also --stdin / --file, --no-insert)
serve-sim rotate <orientation> [-d udid]
                                      portrait | portrait_upside_down |
                                      landscape_left | landscape_right
serve-sim ca-debug <option> <on|off> [-d udid]
                                      Toggle a CoreAnimation debug flag
                                      (blended|copies|misaligned|offscreen|slow-animations)
serve-sim fold <deg> [-d udid]  Set a Duo hinge angle (0–180)
serve-sim repair-input [-d udid]         Repair Device Hub input (restarts apps)
serve-sim memory-warning [-d udid]    Simulate a memory warning
serve-sim event-log [-d udid]         Show recent simulator events
serve-sim exec <command...> [-d udid] Run a host shell command through a server
                                      started with --allow-exec. One argument
                                      is a shell line (exec "xcrun simctl list");
                                      several are quoted as an argv
serve-sim doctor [-d udid]            Collect redacted diagnostics for bug reports
                                      (--json, --out <file>)
serve-sim record [-d udid]            Record the screen to an MP4 (native resolution,
                                      60 fps H.264); Ctrl+C stops. -o <file>,
                                      -t <duration>, --codec h264|hevc, --fps, --bitrate,
                                      --no-index (skip the .index.jsonl sidecar)
serve-sim record frame <mp4> -t <s>  Frame nearest a time as a PNG (-o <file>|-, --index)
serve-sim record diff <mp4> --from <s> --to <s>
                                      Highlight PNG + {changedPixels, bbox} between two times
serve-sim record changes <mp4> [--from <s>] [--to <s>]
                                      Changed frames + nearby input, from the sidecar only
serve-sim buffer [status|start|stop|list|frame|dump] [-d udid]
                                      Opt-in rolling buffer of recent small frames
                                      (off by default; see "Rolling buffer" below)
serve-sim ax [-d udid]                Dump the accessibility tree as JSON
serve-sim ax --refs [--all] [--text]  Compact snapshot with element refs (@e1…)
serve-sim tap @e2 [--settle] [--timeout <ms>]
                                      Tap an element ref; --settle prints the diff
serve-sim settle [--timeout <ms>]     Wait for the screen to settle; print the diff

serve-sim camera <bundle-id> [-d udid] [source-options]
                                      Inject a synthetic camera feed and (re)launch the app
serve-sim camera switch <placeholder|webcam|file> [arg] [-d udid]
                                      Hot-swap the running helper's source (no relaunch)
serve-sim camera mirror <auto|on|off> [-d udid]
                                      Hot-swap preview-layer mirror mode
serve-sim camera status [-d udid]     Print helper state as JSON ({alive, source, ...})
serve-sim camera --list-webcams       List host camera devices
serve-sim camera --stop-webcam [-d udid]
                                      Stop the camera helper for a device

Options:
  -p, --port <port>   Starting port (preview default: 3200; helper default: 3100)
  -d, --detach        Spawn helper and exit (daemon mode)
      --allow-exec    Enable the host shell (/exec, {command} frames on
                      /exec-ws, `serve-sim exec`) and .ipa installs from
                      the preview. Off by default
  -q, --quiet         JSON-only output
      --no-preview    Skip the web UI; stream in foreground only
      --panes <panes> Initially open preview panes: devices, tools, devtools,
                      or none
      --fit           Initially size the simulator to fit the preview viewport
      --theme <theme> Set simulator appearance before opening the preview:
                      light or dark
      --codec <codec> Stream codec for the preview UI: 'auto' (H.264 when the
                      browser can decode it) or 'mjpeg' (force software JPEG —
                      e.g. on VMs without H.264 encode)
      --max-bitrate <Mbps>
                      Cap the H.264 stream bitrate (default scales with
                      screen size, 6-30 Mbps). Also read from
                      SERVE_SIM_MAX_BITRATE
      --device-set <path>
                      Use this CoreSimulator device set instead of Xcode's
                      default (simctl --set). Applies to subcommands too.
                      Also read from SERVE_SIM_DEVICE_SET
      --list [device] List running streams
      --kill [device] Kill running stream(s)

Camera options (used with `serve-sim camera <bundle-id>`):
  -f, --file <path>          Image or video file (kind auto-detected from
                             extension/magic bytes; videos loop at native FPS)
      --webcam [name]        Live host webcam (defaults to the built-in
                             front camera when [name] is omitted)
      --mirror [on|off|auto] Override preview-layer mirroring (default: auto =
                             front mirrored, back not). Data-output buffers
                             are never auto-mirrored, matching AVF defaults.
      --no-mirror            Shortcut for --mirror off
      --build                Rebuild the dylib + helper from source
```

### Examples

```sh
serve-sim                              # auto-detect booted sim, open preview
serve-sim "iPhone 16 Pro"              # target a specific device
serve-sim --detach                     # start a background helper, return JSON
serve-sim --list                       # show running streams
serve-sim --kill                       # stop all helpers
serve-sim --panes devices,tools --fit  # start with selected panes open and fit the simulator
serve-sim --theme dark                 # start the simulator in Dark Mode
serve-sim --allow-exec                 # enable `serve-sim exec` and .ipa drag-to-install
serve-sim --max-bitrate 8              # cap H.264 at 8 Mbps (slow links / shared hosts)
serve-sim --device-set ~/pool <udid>   # a simulator of another device set

# Type text into the focused field
serve-sim type "Hello, world!"
echo "from stdin" | serve-sim type --stdin
serve-sim type --file ./snippet.txt

# Paste Unicode (emoji, Cyrillic, combining marks) into the focused field.
# POST /pasteboard?device=<udid> with {"text": "..."} (max 256 KiB UTF-8, same
# auth as other routes) succeeds only when `devicectl device pasteboard paste`
# reads back the exact bytes. Cmd/Ctrl+V in the browser preview uses it too.
serve-sim paste "Привет 👩‍🍳"
serve-sim paste --no-insert --file ./notes.txt   # stage only; paste in the guest yourself

# Camera injection
serve-sim camera com.acme.MyApp                            # animated placeholder
serve-sim camera com.acme.MyApp --webcam                   # default webcam
serve-sim camera com.acme.MyApp --webcam "MacBook Pro Camera"
serve-sim camera com.acme.MyApp --file ~/Pictures/face.png # static image
serve-sim camera com.acme.MyApp --file ~/Movies/loop.mp4   # looping video

# Hot-swap source on a running helper (no app relaunch)
serve-sim camera switch placeholder
serve-sim camera switch webcam
serve-sim camera switch ~/Movies/loop.mp4                  # auto-detects file kind

# Other helpers
serve-sim camera mirror on
serve-sim camera status                                    # JSON: alive, source, mirror
serve-sim camera --list-webcams
serve-sim camera --stop-webcam
```

Multiple booted simulators are supported — pass several device names, or leave it empty to attach to all of them.

Helpers started by `--detach` or `--no-preview` exit after their target simulators remain shut down beyond the grace period. A failed check keeps the helper alive.

### Remote access (`--auth-token`)

Requests that don't come straight from this machine — LAN clients, tunnels, reverse proxies — are refused unless the server is started with `--auth-token <token>` (or `SERVE_SIM_AUTH_TOKEN`). CLI and scripted clients send `Authorization: Bearer <token>`. To share the preview with a browser, send the link with the token in the URL fragment:

```
http://<host>:3200/#token=<token>
```

Browsers never send the fragment to the server, so the token stays out of request lines and server/proxy logs. The page that loads first is a small auth bootstrap (it contains no secrets): it reads the fragment, removes it from the address bar and history, and POSTs it in a header to the same-origin `/auth` endpoint, which sets an HttpOnly, `SameSite=Lax` cookie and the page reloads. `/auth` only accepts same-origin `POST`s, compares in constant time, and locks out after 10 wrong tokens a minute. A `?token=` query parameter is never accepted.

### Host shell (`--allow-exec`)

The host shell — `POST /exec`, `{command}` frames on the `/exec-ws` control channel, and `serve-sim exec` — runs commands on the host, so it is off unless the server is started with `--allow-exec`; otherwise `/exec` answers `403 {"error":"exec disabled; start with --allow-exec"}` and `{command}` frames get `exec disabled`. Installing an app (dropping an `.ipa` on the preview) runs arbitrary code on the host too, so it also requires `--allow-exec` (`installApp requires --allow-exec`). The other preview tools (screenshots, camera, permissions, location, media drops, reveal in Finder) don't need it: they use fixed, validated host actions with no shell, available to loopback same-origin pages. Even when enabled, `/exec` is loopback-only and requires a per-session token that is never sent in any HTTP response: the server writes it to an owner-only file under `$TMPDIR/serve-sim/exec-tokens/` (removed on stop), and `serve-sim exec` reads it from there. A raw TCP forward of the preview port (`ssh -R`, socat) looks like a local client, so only enable `--allow-exec` on a port nobody else can reach. Note that `installApp` needs no exec token: with `--allow-exec` it only requires a same-origin loopback page, so anyone who can reach an `--allow-exec` port through a raw `ssh -R` or socat forward can install (and so run) arbitrary apps on the host.

`--detach` and `--no-preview` reuse a running server only when it was started with the same `--auth-token` (or with none on both sides) and the same `--allow-exec` setting (on or off on both sides); otherwise they exit with an error — stop the old server with `serve-sim -k <udid>` first.

### Device sets (`--device-set`)

Tools that keep simulators in a CoreSimulator device set of their own (device pools, CI runners) put them where `simctl list` and Simulator.app never look. `--device-set <path>` (or `SERVE_SIM_DEVICE_SET`, an existing directory) points serve-sim at that set: every `simctl` call gets `--set <path>`, each preview records its set in its state file so previews in different sets never take each other's simulators for shut down, the native capture, input and accessibility bridges look the device up in that set, and per-simulator data (permissions) is read from it. Simulator.app is not opened for such a set, since it only shows Xcode's default one. The flag applies to subcommands such as `serve-sim camera` too (each `camera` subcommand refuses a simulator the set does not list), and a command finds only previews of its own set, whether or not it names a simulator; `-l` and `-k` without a device still list and stop previews in every set. The toolbar's library shell commands (`homeButtonCommand`, the screenshot button) still name no device set; the preview page uses host actions instead.

### Camera

`serve-sim camera <bundle-id>` replaces the simulator's camera feed for a single app. A small host-side helper writes BGRA frames into a POSIX shared-memory region; an injected dylib (`DYLD_INSERT_LIBRARIES`) swizzles AVFoundation inside the simulator process so the app reads from that region instead of the simulator's stub camera.

The helper is one-per-device and outlives any single app launch, so multiple apps on the same simulator can share the feed — just run `serve-sim camera <other-bundle-id>` again to relaunch the next app with the dylib attached. Source changes (`camera switch`) and mirror changes (`camera mirror`) flow through the helper's control socket and don't relaunch the app.

Sources:

- **placeholder** — animated programmatic frames (default).
- **file** — image (PNG/JPEG/HEIC/…) or video (mp4/mov/m4v/webm/…). The CLI sniffs the kind from the extension and falls back to magic bytes for files without an extension.
- **webcam** — live `AVCaptureDevice` (built-in, Continuity, external).

Movies an app records from the injected camera (`AVCaptureMovieFileOutput`, as in expo-camera's `recordAsync` and VisionCamera) are video-only: they have no audio track, even with `recordAsync({ mute: false })`.

### Screen recording

The record button in the preview toolbar and `serve-sim record` both drive a native recorder in the server: it encodes the simulator framebuffer directly (full native resolution, constant frame rate, hardware H.264/HEVC), independent of the stream codec the viewer uses. Stopping streams the finished MP4 to the client that stopped it (a browser download, or the `-o` file) and deletes the server's temp copy. One recording runs per device; any client may stop it, and a `serve-sim record` whose recording is stopped elsewhere exits with an error instead of saving.

A recording is capped at 30 minutes. At the cap the server finalizes the file and holds it for the client that started it, which collects it automatically. If that client has gone away (tab closed, `serve-sim record` killed), the hold lapses after 5 minutes: then any client may collect it with Stop, and starting a new recording discards it.

`serve-sim record` also writes a recording index next to the MP4, `<name>.index.jsonl` (skip it with `--no-index`), so tools can find what changed when without decoding the video. It is JSON Lines, in this order:

- `header`: file, fps, codec, size, rotation, and the clock join (`clock`; the `doc` field spells out each value).
- `frame`, one per sample in the MP4: `i` numbers the samples, `pts` (seconds) gives the sample's slot on the fps grid, `uptime` is the host uptime the source frame was captured at, and `changed` says whether its pixels differ from the previous sample by the framebuffer's surface seed. Repeated and idle slots are `false`; an app redrawing identical pixels can still read `true`. When the encoder is busy a slot can be skipped, so `pts` can have gaps that `i` does not.
- `event`, one per HID input to that device during the recording: `t` in media seconds, `kind`, `action`, `summary`, and normalized `x`/`y` when the input has a point. A drag is one event: `t` when it started and `tEnd` when its last point `x`/`y` arrived, clamped to the recording when it crosses the start or stop.
- `footer`: `frames` (the number of `frame` lines, which can be lower than the summary header's `frames` slot count when slots were skipped), `changedFrames`, `durationSec`, `events`, `eventsDropped` (more than 50,000 inputs overflowed the event list), and `truncated` (the frame list overflowed).

Event-log times are wall clock. The header's `clock` gives the wall clock minus host uptime offset, sampled once when recording starts, and the uptime of `pts` 0, so an event's media time is:

```
t = (Date.parse(timestamp) / 1000 - wallMinusUptimeSec) - originUptime
```

Events are logged when the server handles the input, so the frames they cause follow a frame or more later.

Indexing is opt-in per recording: `serve-sim record` starts with `index=1` (unless `--no-index`), and so does the preview toolbar's record button while the scrub timeline is open (see below). Recordings without it collect nothing extra. Any HTTP client can start with `POST …/recording/start?index=1` and fetch the index after `/recording/stop` with `GET …/recording/index?token=<start token>`. The server keeps the last four indexes, each for 30 minutes after its MP4 has finished downloading; an optional `&file=<name>` only relabels the header's `file` and the download name. The stop response itself is unchanged. If the index has expired or been evicted, `serve-sim record` warns and keeps the MP4.

Limitations:

- **Rotation is fixed at start.** The file's orientation comes from the simulator's orientation when recording starts; rotating mid-recording leaves the rest of the footage sideways. Stop and start a new recording after rotating.
- **Size changes freeze the video.** A track can't change dimensions, so if the screen size changes mid-recording (e.g. switching the Duo's active panel), frames at the new size are dropped and the rest of the video repeats the last frame at the original size.

#### Inspecting a recording

Three offline commands read a finished recording so an agent can check what happened without opening the video. They need no server or simulator. `frame` and `diff` decode with AVFoundation through the native addon, so no ffmpeg is needed. Each prints one JSON line. The sidecar is found at `<name>.index.jsonl` next to the MP4, or wherever `--index <path>` points. Times are seconds (`1.5`, `2s`, `250ms`).

```bash
# The sample nearest t as a PNG (default rec-t2.3.png next to the MP4; -o - pipes it to stdout)
serve-sim record frame rec.mp4 -t 2.3
# {"i":138,"pts":2.3,"decodedPts":2.3,"changed":true,"path":"rec-t2.3.png","width":1206,"height":2622}

# What changed between two times: the later frame dimmed, changed pixels magenta, bbox outlined
serve-sim record diff rec.mp4 --from 0.9 --to 1.0
# {"from":{"i":54,"pts":0.9,"decodedPts":0.9},"to":{"i":60,"pts":1,"decodedPts":1},"changedPixels":124722,
#  "bbox":{"x":79,"y":271,"w":493,"h":493},"threshold":40,"maxDelta":255,"path":"rec-diff-0.9-1.png",…}

# Changed frames in a window and the input near them (sidecar only, never decodes)
serve-sim record changes rec.mp4 --from 2.2 --to 2.4
# {"fps":60,"durationSec":5.016667,"clock":{…},"window":{"from":2.2,"to":2.4},"complete":true,"truncated":false,
#  "eventsDropped":0,"changedFrames":9,"frames":[{"i":136,"pts":2.266667},…],
#  "events":[{"t":2.2811,"kind":"tap",…,"nextChange":{"i":137,"pts":2.283333}}],"unmatchedEvents":[]}
```

- `frame` and `diff` pick the sample whose `pts` is nearest each time. They use the sidecar's frame times (and report `changed`) when it exists. Without one, or when it is `truncated`, they read the MP4's own sample times, and `i` counts the MP4's samples. A time outside `0…duration` is an error. They decode the middle of the chosen sample and check the decoder returned that sample (`decodedPts` is its MP4 time, which can differ from a sidecar `pts` by the MP4's 1/600 s rounding); a mismatch is an error rather than a mislabelled frame.
- `diff` counts a pixel as changed when a color channel differs by more than `--threshold` (default 40, above the H.264 noise between identical frames). `threshold` echoes the value used and `maxDelta` is the largest channel difference anywhere, so when `changedPixels` is 0 but `maxDelta` is close to `threshold`, retry with a `--threshold` below `maxDelta`. `--from` after `--to` is an error. `bbox` is in pixels of the displayed frame and is `null` when nothing changed.
- `changes` keeps an event when a changed frame in the window is within `--near` seconds (default 0.5) of it. Each kept event gets `nextChange`, the first changed frame at or after it. Events in the window with no changed frame that near (e.g. a tap the app ignored) are listed in `unmatchedEvents`. `complete` is false when the sidecar has no footer (cut short), `truncated` is true when it hit its frame cap, and `eventsDropped` counts input it didn't record; each also prints a warning on stderr. Without a sidecar `changes` exits 1: re-record without `--no-index`.

### Rolling buffer (what just happened?)

An optional rolling buffer keeps the last few seconds of the screen as small JPEG stills, so an agent can look back at what a tap or a crash did without having started `serve-sim record`. It is **off by default**. While off, nothing extra runs: no timer, no native calls, no event-log subscription, and the stream and recorder are unchanged.

```bash
serve-sim buffer start               # this device, until stopped (or the server exits)
serve-sim --buffer 30                # or: every device the server serves, from startup (also SERVE_SIM_BUFFER=30 / on)
serve-sim tap 0.5 0.35
serve-sim buffer list --since 5      # changed frames + input, as seconds before now
#   -2.09s  tap  Tap 0.5,0.35  → frame 89 after 0.25s
#   -2.09s  frame 88   294x640  26.3 KB
#   -1.84s  frame 89   294x640  25.1 KB
serve-sim buffer frame --ago 2 -o before.jpg    # the frame on screen 2 s ago (or --id 89; piped: stdout)
serve-sim buffer dump                # every frame + buffer.json into a new temp dir (or -o <empty dir>); frames evicted mid-dump are marked missing
serve-sim buffer stop                # turn it off and free the frames
```

`buffer start` takes `--seconds` (window, 1-60, default 20), `--fps` (1-10, default 4), `--size` (long edge in px, 64-1280, default 640), `--quality` (JPEG, 0.1-0.95, default 0.6) and `--max-mb` (memory cap, 1-64 MiB, default 24). Out-of-range values are refused, not clamped. A second `start` with the same options is a no-op; with other options it is refused until `buffer stop`. `buffer` alone prints the status as JSON. `--buffer` on the server applies the defaults with that window to every device it serves (pass a device as `serve-sim --buffer=20 <device>`, since `--buffer <device>` reads the device as the seconds); if a server for the device is already running, `--buffer` starts the buffer on it, or warns when it can't.

How it samples: at each tick the server reads the capture's content-change counter (the one `settle` uses). Only when the screen changed does it copy the current frame, downscale it and encode a JPEG, on a low-priority queue separate from the stream encoders. An unchanged tick stores a repeat entry pointing at the previous frame (no bytes), so timestamps stay on a steady grid and events can still be placed. A snapshot identical to the previous frame is stored as a repeat too. Each sample is `{t, at, frame, changed}`, with `t` in seconds from the oldest sample in the view.

Memory is bounded three ways: samples older than the window are dropped, frame bytes are capped at `--max-mb` (oldest frames go first, the newest always stays), and samples and events have fixed caps. A frame is freed as soon as no sample shows it. On an iPhone 17 Pro (1206x2622) a 640 px frame is 294x640 and was 23-29 KB on Settings. If the screen changes on every tick, that is about 2 MB for the default 20 s at 4 fps, 6 MB for 30 s at 8 fps, and 16 MB for the maximum 60 s at 10 fps. Photo-heavy screens are larger, and there the cap applies. A static screen stores one frame.

Overhead measured on that device while scrolling Settings continuously with an H.264 viewer attached: 8.7-9.1% of one core for the server with the buffer off, 9.6-10.1% with it on (defaults, a new frame on every tick), so about one percentage point. A static screen showed no measurable difference (2.5% vs 2.6%).

Events: while the buffer is on it collects this device's HID input from the event log (the same events and shapes as the recording index). Each event in `list --json` / `buffer.json` carries `frame` (on screen when the event arrived) and `nextChange` (`{frame, t, after}`, the first changed frame after it, or after a drag's last point). Times are server wall clock, so no clock join is needed.

HTTP, under the same device helper routes and auth as `/recording` (`--auth-token` remotely; start/stop need a same-origin `Origin` from browsers):

- `GET …/helper/<udid>/buffer[?since=<s>][&events=0]`: `{enabled:false}`, or `{enabled, options, startedAt, stats, origin, now, samples, frames, events}`. `?stats=1` returns only `{enabled, options, startedAt, stats}`.
- `POST …/buffer/start?seconds=&fps=&size=&quality=&maxMB=` and `POST …/buffer/stop`.
- `GET …/buffer/frame[?id=<n> | ?ago=<s>]`: one `image/jpeg`, the latest by default, with `X-Serve-Sim-Buffer-Frame: {id, at, width, height, sourceWidth, sourceHeight}`. `409 buffer_off` when off, `404 frame_not_found` when it isn't held.

Limits: sampling at 4 fps can miss a state shown for less than a tick (record for frame-exact history). Frames are the raw framebuffer orientation, like the stream before rotation. When serve-sim is embedded as middleware, `SERVE_SIM_BUFFER` in the dev server's environment starts the buffer when a device's session opens (its first viewer or command), not at startup.

### Scrub timeline (web UI)

The history button next to record in the preview toolbar opens a timeline under the device. It scrubs either the rolling buffer or a finished recording, with HID input drawn as markers: taps as dots, drags as bars, other input (buttons, keys) as squares. Hover or click a marker for its kind, time, and where it landed (normalized %), and the scrubbed frame shows a ring at the tap or a line along the drag.

- **Buffer**: when no recording is selected and the buffer is on, the track re-reads `GET …/buffer` about once a second (each read waits for the last; an unavailable buffer is asked less and less often, up to every 30 s) and freezes while you scrub; frames come from `GET …/buffer/frame?id=` (at most three at a time, cached). Buffer frames and event points are raw framebuffer orientation, so in landscape the scrubbed frame and its ring are rotated with the live stream. If the buffer is off, the timeline offers a Start buffer button.
- **Recording**: a recording started from the toolbar while the timeline is open is indexed (`index=1`). After it downloads, its sidecar comes from `GET …/recording/index?token=` and the MP4 you just saved plays in the browser (no ffmpeg, no server-side copy). If you closed the timeline before the recording finished, it loads when you reopen it; each recording is loaded once, and the page drops its copy of the MP4 once the recording is loaded or has failed to load. Markers on a recording use the sidecar's `rotation`, so they line up with the upright video. The folder button opens an `.mp4` together with its `.index.jsonl` from `serve-sim record`.

Click or drag on the track to seek. While a past frame covers the screen it takes the pointer, so you can't tap the live app by mistake. With the track focused, ←/→ steps one frame, ⇧←/⇧→ jumps to the previous/next marker, Home/End go to the ends, Space plays and pauses, and Esc (or Live) returns to the stream. These keys are handled only while the track has focus; elsewhere they still go to the simulator. While the timeline is closed it makes no requests, and recordings, the stream, and the buffer behave exactly as before. It is not offered on iPhone Duo (its screen is a 3D projection).

### Accessibility refs for agents

`serve-sim ax --refs` prints a compact snapshot of the visible screen: each interesting element gets a short ref (`@e1`, `@e2`, …, in tree order), its role, label, value (when set), `enabled: false` (only when disabled), and its frame and center in device points. `--all` includes offscreen elements; `--text` prints one line per element.

```bash
serve-sim ax --refs          # {"screen":{"width":402,"height":874},"nodes":[{"ref":"@e2","role":"button","label":"General",…}]}
serve-sim tap @e2 --settle   # taps General's center, waits, prints {settle:{settled,waitedMs,reason}, diff:{added,removed,changed}}
serve-sim settle             # after any other action: wait for quiet, diff vs the last state you were shown
```

The server remembers the last snapshot per device, so a ref always means the element you saw. Before tapping, it looks the element up in the live tree and taps it where it is now. If the element has gone or scrolled offscreen, or the ref was never issued, the tap is refused (exit code 1, `stale_ref` / `unknown_ref` / `offscreen` on stderr) and nothing is tapped. Take a new snapshot and retry.

A ref carries over to a new snapshot only when serve-sim can tell it is the same element. When in doubt the ref goes stale, because a refused tap beats a tap on the wrong element, and a stale ref is never handed to another element. The rules:

- **Other content in the same place retires every ref on the screen.** That happens when a labelled (or value-only) text, heading, cell, button, link, image or group is replaced by another of the same type in the same place, after allowing for the scroll measured from the labels that survived. "The same place" means the two overlap horizontally and either overlap vertically or share a top edge within 8 points; width, height and exact position don't matter, since a label is as wide as its text and is laid out around it. Duplicates count: the old name must now occur fewer times and the new one more times than before, or the two must have traded places (each now where the other was, not still in its own place), or the new name must have jumped into the old name's place past a label that stayed put (from below the action buttons to above them, which a row deleted with the rest reflowing up never does), or the new name must only have moved there from elsewhere on screen and, followed back to where it was (up to four places), lead to new content or back to the start. A name that moved by the same offset as the labels around it (a scroll, a deleted or inserted row) is not followed. It also happens when a uniquely labelled element keeps its label but shows another read-only value: such as a cell, text, button or link value, or the label of a text, cell, heading, group, image or combined element with an accessibilityIdentifier (a React Native `testID` on an `accessible` View or avatar). A visible heading or navigation-bar title that vanished without scrolling away, or headings that changed order, count too. So a contact card whose only difference is the name retires its refs, however many "Share Contact" / "Block this Caller" buttons the two cards share. That holds when the name is plain text, a heading, a button or a combined element ("Alice, mobile"), or labels the avatar image, with or without an accessibilityIdentifier (except a Button or Link, see the gaps below). It holds when the names differ in width or one wraps to two lines, when a wrapped name is recentred beside an avatar or pushed down by an optional company line in a fixed-height header, and when the other card has an extra row that pushes the buttons down. It also holds for an iPad split view whose detail pane switches from Alice to Bob while both names stay in the list, and when the card's name and a linked contact's name trade places. It holds along a chain of records, too: Alice's card naming her manager Bob followed by Bob's card naming Carol, or a mail thread from [Alice, Bob] followed by the next from [Bob, Carol], and when three or more names rotate places. It also holds at the end of a chain, when the related record has no related record of its own: Alice's card naming her manager Bob followed by Bob's card with no manager row, or Alice's related people [Bob, Dave] followed by Bob's [Dave]. So does a full-page scroll that shows other rows.
- **Otherwise an element needs a key that is unique on the whole screen**, offscreen elements included: its accessibilityIdentifier, or its type and label (or value, for text with no label). Duplicates and unlabelled elements instead need a frame (and value) that still picks out one element after the scroll measured from their neighbours. Duplicates inside a labelled row (a "Delete" button per contact) are told apart by that row's label.
- **The content around it must also have survived**, identifiers included. The first heading or navigation-bar title of each enclosing group must not have been replaced, and so must most of the uniquely labelled elements in its nearest labelled group, most of the ones on its own row, and most of its three nearest.

Typed text and on/off state don't count as content, so editing a field or flipping a switch keeps refs.

The flip side is churn. Navigating to another screen almost always retires every ref on it, tab-bar and back buttons included. So does any text that changes in place, whatever its new size and even if it shifted or wrapped within its old place: a counter, a status line ("9 of 10" → "10 of 10"), a timer, a cell value, or a button that relabels itself ("Follow" → "Following"; one with an accessibilityIdentifier keeps its refs). So does a list re-sorted in place (names moving into each other's places by different amounts). Look-alike elements with nothing (no label, id or value) around them to tell them apart retire on every snapshot, even when nothing moved. Take a new snapshot when a ref goes stale.

Known gaps:

- **Editable fields.** Two screens that differ only in the contents of text fields, search fields or text areas look identical, because the accessibility tree doesn't say which field has focus, so typing can't be told apart from another record's form. Their refs carry over: "Delete Contact" on Alice's edit form keeps its ref on Bob's if nothing else differs.
- **No labelled content at all.** An element with no uniquely labelled content around it (a lone button on an otherwise empty screen) carries on its id or label alone. An accessibilityIdentifier reused across such screens names whichever screen is showing. A lone key also carries wherever it moved: if nothing else on the screen changed, a text that moved to another spot keeps its ref (it shows the same label, so a tap lands on the same words).
- **A name that changed and also moved clear of its old place.** If the other record's name no longer overlaps where the old one was (say a much taller photo above it pushes it below the old name's bottom edge) while every shared button stays put, it isn't seen as a swap, and chains longer than four places aren't followed. The other checks (titles, values, the surrounding labels) still apply, but shared buttons can then outvote the one name that changed.
- **A name Button or Link with an accessibilityIdentifier is not checked as a record name.** An identified control's label is treated as its state ("Play" → "Pause" keeps refs), so a tappable name button keyed by a `testID` that shows Bob instead of Alice carries the refs around it unless something else differs.
- **A name that changes element type.** Names are compared only with names of the same type, so plain text "Alice" becoming a tappable "Bob" button (Bob's name links to a profile) isn't seen as a swap.
- **The next mail thread that looks like a deleted message.** A thread from [Alice, Bob] (or [Alice, Bob, Carol]) followed by one from [Bob] (or [Bob, Carol]) with the same subject and identical other text looks exactly like deleting the first message, with the rest reflowing up, so toolbar buttons such as Delete carry over.
- **Identical trees.** Two screens with byte-identical accessibility trees can't be told apart, such as an unlabelled photo grid under a sticky header scrolled by exactly a page.

Elements that appear in a diff come with refs you can tap right away.

The screen counts as settled when the captured framebuffer has stopped changing for 250 ms and one AX read taken after that saw no new frame (`reason: "frames-quiet"`; a push navigation settles about 1.4 s after the tap). On screens that never stop drawing, such as a blinking caret or a spinner, it settles once two consecutive AX reads match after about 1.2 s of motion (`"ax-quiet"`), which is also the only check when frames aren't available. `--timeout` (default 3000 ms, max 30000) is a hard limit: the wait reports `settled: false`, `reason: "timeout"` and what was still busy, and still returns the current tree; the command exits 0. Agent snapshots use a faster AX discovery than the raw `/ax` dump, roughly 150-250 ms on typical app screens. When nothing on screen has changed since the last snapshot, `tap @eN` taps from that snapshot without reading the tree again. Diffs (`tap @eN --settle`, `settle`) are taken against the last state returned to you, the latest snapshot or diff, so an element that appeared in a pre-tap read you never saw still shows as `added`. Accessibility requests run one at a time per device; with four already running or queued, more are refused with `429 busy` (retry when they finish). `HEAD /ax/snapshot` and `HEAD /ax/settle` answer `200` without reading the tree; they are liveness probes and don't check that accessibility is available. Coordinate taps (`serve-sim tap <x> <y>`) are unchanged. Like the other input commands, `ax` (with or without `--refs`), `tap @eN` and `settle` take `--url` / `--auth-token` (or `SERVE_SIM_URL` / `SERVE_SIM_AUTH_TOKEN`) to drive a remote preview.

## Connectors

`serve-sim` can be used with dev servers, browser, and AI editors for more seamless integration.

### Agent Skill

An [Agent Skill](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) ships in [`skills/serve-sim`](skills/serve-sim) — it teaches AI coding agents (Grok, Claude Code, Cursor, Codex CLI, Gemini CLI, and any host implementing the open Agent Skills standard) how to drive a simulator through the CLI: taps, gestures, hardware buttons, rotation, camera injection, and handing the stream off to the host's preview pane.

```sh
bunx add-skill EvanBacon/serve-sim
# in Claude Code:
/plugin marketplace add EvanBacon/serve-sim
```

See [`skills/serve-sim/README.md`](skills/serve-sim/README.md) for the full capability list.

### Claude Code Desktop

Create a `.claude/launch.json` and define a server:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "Apple",
      "runtimeExecutable": "npx",
      "runtimeArgs": ["serve-sim"],
      "port": 3200
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
```

Host-shell features are off unless you pass `allowExec: true`. The middleware reads the helper's state from `$TMPDIR/serve-sim/` and hands the browser same-origin `/.sim/helper/<device>` and `/.sim/devtools` URLs for the stream, interaction WebSocket, and WebKit DevTools; the middleware proxies them to the helper. The helper itself sends no CORS headers and only accepts same-origin WebSockets, so an embedded page can't talk to the helper's port directly.

### Forward WebSocket upgrades

Simulator input, the control channel, and DevTools are WebSockets, so forward your server's `upgrade` events under the mount path to `handleUpgrade`. `handleUpgrade` closes any socket it doesn't own, so leave every other upgrade (HMR, your app's own sockets) to your server's existing handlers:

```ts
const basePath = "/.sim";
const middleware = simMiddleware({ basePath });
app.use(middleware);

const server = app.listen(3000);
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === basePath || pathname.startsWith(`${basePath}/`)) {
    middleware.handleUpgrade(req, socket, head);
  }
  // Anything else belongs to the host server's other upgrade listeners.
});
```

Without that, the page still loads video over HTTP but loses simulator input and DevTools (their sockets never reach the proxy). The same setup exposes the preview to remote viewers behind a single port (the way standalone `serve-sim` does), so the per-device helper port and inspect-webkit bridge can stay local to the host. When terminating TLS at a reverse proxy, forward `X-Forwarded-Proto` so the helper URLs use `https`/`wss` and avoid mixed-content blocks.

Pass `proxyHelpers: false` to hand the page the helper's direct URLs instead; that only works when the page is served from the helper's own origin.

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
