# Observability

> Remote readback of `/api/event-log` needs the auth gate from [PR #166](https://github.com/EvanBacon/serve-sim/pull/166). Merge that before relying on off-loopback log access.

serve-sim already keeps an in-memory **event log** of simulator actions. This
document describes what that log records today, the small, additive fields that
make the silent failures ([#153](https://github.com/EvanBacon/serve-sim/issues/153),
[#136](https://github.com/EvanBacon/serve-sim/issues/136),
[#143](https://github.com/EvanBacon/serve-sim/issues/143),
[#103](https://github.com/EvanBacon/serve-sim/issues/103),
[#128](https://github.com/EvanBacon/serve-sim/issues/128),
[#102](https://github.com/EvanBacon/serve-sim/issues/102)) reproducible from the
log alone, and the exact code hook that produces each field. It is built on the
log we have -- no span tree, no histograms, no OpenTelemetry SDK is implied.

Timing is the same entries. A duration is an additive key (`input.send_ms`,
`stream.ttff_ms`, `stream.reconnect_ms`, `stream.producer_frame_age_ms`,
`camera.helper_shutdown_ms`, `helper.uptime_ms`). Omit the key when the number
would be a lie (false stall, stuck Connecting, dead injector, still-booted
helper). Do not invent a parent span to carry it.

The event log is a diagnostic side-channel. It must never fail the input or
command path (`recordEventLogEvent` already swallows subscriber errors), and it
is **on by default**; remote export is strictly opt-in (see Privacy below).

## What the event log records today

`src/event-log.ts` keeps a bounded ring (`EVENT_LOG_MAX_ENTRIES = 500`) of:

```ts
type EventLogEntry = {
  id: number; timestamp: string;
  source: "hid" | "exec" | "ui";
  kind: string; msg: string; summary: string;
  device?: string; action?: string;
  status?: "ok" | "error";
  details?: Record<string, unknown>;
};
```

- **HID input** -> `handleHidMessage` (`src/device-session.ts`) routes tag `0x03`
  touches to `DeviceSession.recordTouchEvent` and every other tag to `recordHidEvent`
  -> `eventLogEventForHidMessage(device, tag, payload, screen)`. Tap events come from
  `recordTouchEvent`: it folds begin/move/end into one `kind:"tap"` or `kind:"drag"`
  entry (top-level `source:"hid"`) whose details (`touchGestureDetails`) carry `type`,
  `start`, `current`, `moveCount`, optional `edge`, and `screen = {width,height}` (via
  `eventLogScreen()`). The only `kind:"touch"` entries are its fallthrough: an `end`
  with no preceding `begin`, or an unknown `type`, goes to
  `recordHidEvent(0x03, …)`, whose `0x03` branch builds a per-phase `kind:"touch"`
  entry.
- **Shell actions** -> `eventLogEventForCommand(command, {exitCode})`, parsed in
  `src/middleware.ts` from the `/exec` path. It already drops upload plumbing and
  never records raw command strings with tokens.
- **UI settings** -> `recordEventLogEvent({source:"ui", ...})` in `middleware.ts`.

It already redacts: printable keystrokes (tag `0x06` records `key:"character"`,
`redacted:true`, no usage), token-bearing commands (returns `null`), and it only
ever stores **normalized** coordinates plus screen dimensions -- never pixels.

## How a bot reads it back

- `GET {url}/api/event-log?device=<udid>&since=<id>&limit=<n>` -> `{ events: [...] }`
  (`readEventLog` in `middleware.ts`).
- `GET {url}/api/event-log/events` -> SSE: a snapshot, then one `{ event }` per new
  entry (`subscribeEventLog`; the browser UI reaches it through the exec-ws proxy).
- CLI: `serve-sim event-log --json [-d <udid>] [--limit <n>]`
  (`eventLog()` in `src/index.ts`, which fetches `/api/event-log`).

Add a top-level **`schema_version`** to the `/api/event-log` (and SSE) response
envelope so a reader can tell which of the fields below are present. Every field
added here is additive; an older consumer ignores unknown keys.

## Making the #153 touch miss reproducible from the log

#153: a tap exits 0 and the screenshot is unchanged because the point was sent in
the wrong coordinate frame. The server path `handleHidMessage` ->
`this.hid.touch(type, x, y, W, H, edge)` never remaps: `SimHID.touch` expects the
native portrait frame, so each client must remap before sending. The web client
already does (`rawPointForDisplayPoint` in `client/simulator/orientation.ts`, called
from `SimulatorView.tsx` with `streamDisplayGeometry(...).inputOrientation`). On
`main` the CLI (`tap()` / `gesture()` in `index.ts`) sends the display-normalized
point unchanged, which is the #153 miss.

**Fixed by [#167](https://github.com/EvanBacon/serve-sim/pull/167) (pending).** It
adds `src/touch-remap.ts`, and `tap()` / `gesture()` call `touchInputOrientation`
(`index.ts`) before sending:

- **Config lookup with the socket's auth.** `configUrlForWsUrl` derives the `/config`
  URL from the HID socket URL (`…/helper/<udid>/ws` -> `…/helper/<udid>/config`,
  `wss:` -> `https:`), so it works for local state files and `--url` remotes. It is
  fetched with the same headers as the socket (`Authorization: Bearer <token>` from
  `--auth-token` / `SERVE_SIM_AUTH_TOKEN`), 2 s timeout.
- **Landscape display -> raw.** `cliInputOrientation` applies the viewer's own rule
  (`streamDisplayGeometry(...).inputOrientation`: remap only when the raw frame is
  still portrait while the UI is rotated), and `displayTouchToRaw` converts the point
  with `rawPointForDisplayPoint` and a non-zero `edge` with `rawEdgeForDisplayEdge`.
- **401/403 warns, then sends unmapped.** A refused `/config` prints a warning to
  stderr (pass `--auth-token` to remap, or `--raw`) and the touch is sent as-is; the
  command still exits 0. Any other non-OK status, a network error, or a timeout
  silently falls back to no remap.
- **Foldables skipped.** A `/config` carrying `hingeDegrees` returns no remap, since
  the viewer renders the Duo projection and sends those touches unrotated.
- **`--raw`** on `tap` / `gesture` skips the lookup and sends the coordinates as given
  (native portrait frame).

Even with #167 merged, nothing in the log distinguishes a coordinate miss (`--raw`, a
401/403 on `/config`, a stale `orientation`, an old CLI) from a dead injector.

Add these keys to the `details` of `tap`/`drag` entries (built in
`DeviceSession.recordTouchEvent` via `touchGestureDetails`):

| Field | Values | Source / hook |
|---|---|---|
| `coord_space` | `normalized_0_1` | constant; the `0x03` payload is always 0..1 normalized |
| `orientation` | `portrait` \| `portrait_upside_down` \| `landscape_left` \| `landscape_right` \| `unknown` | `screenConfig().orientation` (i.e. `this.orientation`) read **at record time** |
| `frame` | `display` \| `native_portrait` | which space the point was in when sent: `native_portrait` when the sender remapped (the web client and #167's CLI whenever `inputOrientation` is set); `display` when it did not (pre-#167 CLI, `--raw`, `/config` refused or unreachable). When no rotation is needed the two are identical. |
| `remapped` | bool | Sender-reported: an extra `remapped` key in the `0x03` JSON, set by the web client and the #167 CLI to whether `inputOrientation` was defined (`false` for `--raw` / a refused or unreachable `/config`). The server can't infer it from `source` alone, since both clients now remap. Omitted when the sender doesn't send it, and for Duo. |
| `observed_orientation` | string | Polled UI orientation (`simctl io enumerate`); can lag ~1s. Do **not** write into `this.orientation` / `broadcastConfig()`. |
| `remap_expected` | bool | Rule applied to `observed_orientation` when present, else `orientation`. Omitted for Duo (`hingeDegrees != null`): Duo web touches use 3D projection, not `rawPointForDisplayPoint`. |
| `source` | `cli` \| `web` \| `unknown` | who sent the frame (see below) |

A web miss is `remap_expected=true`, `remapped=false`: the browser hadn't been told about the rotation.
| `screen` | `{width,height}` | already recorded via `eventLogScreen()` |
| `screen_changed` | bool | guest-effect signal (see below) |
| `input.send_ms` | number, omitted on a dead injector | socket write to ack or fire-and-forget close (see Timing) |

**`source` (cli vs web), compatibly.** Both CLI and browser touches arrive over the
separate WebSocket connections to the same handler (`attachHidInProcess` -> `attachHidSocket` -> `handleHidMessage`) and are recorded as
`source:"hid"`, so the log can't say which client sent them. Add an extra key to the
`0x03` JSON payload -- `{type,x,y,source:"cli"}` from `tap()`/`gesture()` in `index.ts`,
`{...,source:"web"}` from `SimulatorView.tsx` -- and read it in `recordTouchEvent`, stored
as `details.source` (the `source` field in the table above; distinct from the
entry's top-level `source:"hid"`). It is an
extra JSON field: the native `touch()` call ignores it and older clients that omit it
record `source:"unknown"`. (A dedicated tag is unnecessary; the payload is already JSON.)

**Keeping `orientation` current when rotation happens outside `0x07`.** For non-Duo
devices `this.orientation` is only updated when a `0x07` rotate message is handled
(`device-session.ts`: `if (this.duo.hinge == null) this.orientation = m.orientation`).
A rotation triggered from the Simulator menu or forced by the app is **not** reflected.
Two real hooks fix this: (1) `onSharedMjpegFrame` already observes every capture frame
and calls `broadcastConfig()` when `width`/`height` swap -- use that dimension swap to
refresh orientation (portrait<->landscape) rather than caching it per gesture; (2) mirror
the Duo path, which polls on a 1 s timer (`DuoStateMonitor.refreshOrientation` in
`duo-state.ts`), with a lightweight orientation poll for non-Duo sessions: poll `xcrun simctl io <udid> enumerate` (as `DuoStateMonitor.refreshOrientation` does, without hinge/panel `log stream` children) and store the result in `observed_orientation` / a separate field. Do **not** write it into `this.orientation` or `broadcastConfig()` — that would change how the web client remaps input (a behavior fix, not a log field). `parseIntegratedScreenOrientations` only keys Device Names `primary`/`primary-1`; confirm what a non-Duo device reports before reusing it. Either way, read the orientation at the moment the entry is recorded.

**Did the screen change after the tap, without keeping pixels.** `onSharedMjpegFrame`
receives every frame's bytes and dimensions. Maintain a monotonic `frameSeq` and a
cheap content **seed** (e.g. a hash of JPEG length plus a few sampled bytes, or the
IOSurface seed if the capture exposes it) -- not the image. Store `frameSeq` on the gesture at `begin`. At `end`, if `frameSeq` has already advanced (e.g. a touch-down highlight during the CLI's ~40 ms begin→end gap), record `screen_changed:true` immediately. Otherwise record `false` and, on the first higher `frameSeq` / differing seed within the window, call `updateEventLogEvent(tapId, …)`. `recordTouchEvent` must return the entry id (it returns `void` today), and the window timer must be cleared in `close()`. This is the guest-effect evidence that an ack can't provide.

Landscape miss vs portrait hit, same 4 ms send, distinguished only by the repro fields.
`source` is part of the signature: on `main` the miss is the CLI path, not the web
client (which already remaps); after #167 it is a CLI run with `--raw`, a 401/403 on
`/config` (warned on stderr), or an otherwise unreachable `/config`.

```json
{"kind":"tap","status":"ok","details":{"source":"web","orientation":"portrait","frame":"native_portrait","remapped":true,"hid.state":"ok","inject.result":"sent","screen_changed":true,"input.send_ms":4}}
{"kind":"tap","status":"ok","details":{"source":"cli","orientation":"landscape_left","frame":"display","remapped":false,"hid.state":"ok","inject.result":"sent","screen_changed":false,"input.send_ms":4}}
```

The miss is `hid.state=ok` + `inject.result=sent` + `frame=display` + `remapped=false` +
`screen_changed=false` + `source=cli`. Status stays `ok`: the injector did what it was asked.
A #167 CLI tap in landscape is the same entry shape as the web hit: `frame=native_portrait`, `remapped=true`.

## What an ack proves (Evan's default: inject waits for ack, exits non-zero on failure)

Today only `fold` (tag `0x0e`) waits for a reply: it reads the server's
`0x0e {ok}` frame, times out at 10 s, and rejects on failure (`index.ts`). `tap`,
`gesture`, `rotate`, and `button` are **fire-and-forget** -- they write the frame,
wait a 40-50 ms timer, close the socket, and exit 0 unless the socket itself failed.

The default we want is the `fold` pattern for all input: send, wait for a server ack
frame, and exit non-zero when it reports failure. Record the outcome on the entry
(`details.ack = ok | timeout | rejected`, plus `status`). Be explicit about scope:

- An ack **proves** the server received the frame, `handleHidMessage` ran, and the
  native injector returned. The injector boundary is `NativeHid.touch` ->
  `SimHIDHandle.touch` (N-API), wrapped by `guard()` in `native.ts`. `guard()`
  currently swallows **every** error from the native call (sync coercion throws and async rejections alike) and returns a fallback, so a malformed
  send looks successful -- record whether `guard()` swallowed an error
  (`inject.result = sent | swallowed | threw`) so #136's dead-injector case is visible.
- An ack **does not prove** the guest UI reacted. That is exactly the #153 gap, and why
  `screen_changed` above is the separate, stronger signal.

## HID health and Device Hub shadowing (#136, and a #153 look-alike)

- **`hid.state`** (`ok` | `stale` | `gone`): HID can die while the pidfile and
  `--list` still say `running: true`. Derive it from the last successful native call
  (`SimHIDHandle` constructed in `native.ts`; sends go through `this.hid.*` in
  `handleHidMessage`) and surface it in `--list` so `running:true` + `hid.state:gone`
  is one object.
- **Device Hub input shadowing.** `src/device-hub-input.ts` checks
  `com.apple.coredevice.dtuhidd.active` (`isDeviceHubInputShadowed` /
  `warnDeviceHubInput`). When Device Hub owns input, legacy HID touches silently no-op --
  which looks exactly like a #153 coordinate miss. Record the shadow state on the
  session (and on any inject that produced no `screen_changed`) so the two are
  distinguishable; `serve-sim repair-input` is the human-only recovery (it restarts
  SpringBoard and closes apps).

#136 is the other 4 ms, and it is not a send duration. `hid.state=gone` sets
`status=error` and **omits** `input.send_ms`, so a dead injector is not bucketed with
the landscape miss:

```json
{"kind":"tap","status":"error","details":{"source":"cli","hid.state":"gone","inject.result":"threw","ack":"rejected","screen_changed":false}}
```

Device Hub shadowing is the third look-alike: the send completed, so `input.send_ms`
stays. `input.shadowed=true` is what separates it from #153 (which has `remapped=false`
and `input.shadowed` absent or false):

```json
{"kind":"tap","status":"ok","details":{"source":"cli","orientation":"portrait","frame":"native_portrait","remapped":true,"hid.state":"ok","inject.result":"sent","input.shadowed":true,"screen_changed":false,"input.send_ms":4}}
```

## Helper lifecycle (#102)

The orphan in #102 was a detached helper still running after the simulator was
`Shutdown`. There are two hooks. (a) `recycle-self` in `readServeSimStates` (`middleware.ts`, from `classifyStaleState`) closes the device session in-process; an entry recorded there survives via `GET /api/event-log`. (b) The `onExit` closure `index.ts` passes to `startSimulatorShutdownWatch` runs only for detached/`--no-preview` servers and calls `process.exit(0)` immediately (best-effort for SSE). The watchdog itself never calls `classifyStaleState`. The pure-state decision path is still `classifyStaleState(state, bootedUdids, pid)` ->
`keep | recycle-self | recycle-helper` and the pure-state watchdog
`startSimulatorShutdownWatch(targets, ...)`, both in
`src/helper-lifecycle.ts`. The watch decision object (`tick` / `nextDelayMs`) is
timer-free, but `startSimulatorShutdownWatch` drives it with a `setTimeout` loop
(re-armed after each `tick` with `nextDelayMs()`). Record one `helper.lifecycle` entry when the watchdog
decides to recycle/exit after shutdown, carrying `sim.booted` and helper uptime.
(There is no separate `serve-sim-bin` process today -- HID and capture run in-process
via the native addon; don't name a binary that doesn't exist.)

`classifyStaleState` returning `keep` does **not** emit the entry and does not record
`helper.uptime_ms`. A still-booted sim is not a recycle duration. The orphan is the
entry with `sim.booted=false` and `decision=recycle-helper`.

- When `recycle-helper` signals a stale helper, keep a module-level `Set<string>` of `device:pid` keys already signalled.

## Stream and camera (correcting earlier mistakes)

- **#128 is a consumer false-stall, not a dead producer.** The watchdog that fires
  "Stream is not producing frames" after a rotation is on the **`fetch()` reader**
  path (the `raw=1` MJPEG consumer read through `body.getReader()`), not the `<img>`
  element. Record a stall entry with the reason and a `producer_live` boolean (the
  capture side is still publishing) so a false stall isn't read as a dead stream.
- **Camera helper exit (#143).** Run the camera helper under a **supervising parent**
  that captures both exit code and signal -- Node reports a `null` exit code when the
  child dies on a signal. Record `camera.helper.exit` with `exit_code`, `signal`, and
  `shutdown_phase`. **SIGPIPE is already ignored**, so a client vanishing mid-write is
  not the cause; the real race was the placeholder timer vs. surface release (mitigated
  by [#161](https://github.com/EvanBacon/serve-sim/pull/161)). Don't attribute it to SIGPIPE.

Keep both as ordinary event-log entries -- no span parenting, no `stream.startup` ->
`camera.frame` tree, no reconnect histograms.

## Timing on those entries

Durations are measured at the hook that already builds the entry, then written with
`updateEventLogEvent` if the end is later than the start (ack, next frame, helper
exit). Units are milliseconds. Missing key means "not a duration", not zero.

A reader pairs each duration with the repro fields on the **same** entry. The fields
decide whether the key is present; they do not live on a second line.

| Key | Entry | Record when | Omit when |
|---|---|---|---|
| `input.send_ms` | tap / button / gesture | socket write to ack, or to the fire-and-forget close if no ack yet | `hid.state=gone` or `inject.result=threw` (#136), or `ack=timeout` (the 10 s wait is not a send). A landscape miss (#153) and a Device Hub shadow still record it. |
| `stream.ttff_ms` | first `stream.frame` | session `start()` to first `onSharedMjpegFrame` (JS-only; client-observed Connecting/stall still need the ingest) | never saw a frame (Connecting before any frame, #103 cold). Do not write `0`. |
| `stream.reconnect_ms` | `stream.state` | consumer left `live` and returned | #128 `producer_live=true` (false stall). #103 stuck Connecting after a good frame (`producer_live=true`, never returns). |
| `camera.frame_interval_ms` | `camera.frame` or `stream.stall` | gap since previous published camera frame | `producer_fps=0` / capture stopped. A long gap is not an interval. #128 may carry the last good interval on the stall entry. |
| `camera.helper_shutdown_ms` | `camera.helper.exit` | supervising parent saw exit, including signal | never. A 48 ms SIGTERM is still `status=error`. |
| `helper.uptime_ms` | `helper.lifecycle` | watchdog decision is `recycle-helper` or `recycle-self` after shutdown | `classifyStaleState` returned `keep`, or pid unknown. #102 is the recycle, not a heartbeat. |

Worked lines (one entry each; no second span line):

```json
{"kind":"stream.stall","status":"ok","details":{"producer_live":true,"orientation":"landscape_left","producer_fps":58,"last_frame_age_ms":6100,"stream.producer_frame_age_ms":17}}
{"kind":"stream.state","status":"error","details":{"producer_live":true,"saw_first_frame":true,"phase":"connecting"}}
{"kind":"stream.state","status":"ok","details":{"phase":"live","saw_first_frame":true,"stream.reconnect_ms":840}}
{"kind":"stream.frame","status":"ok","details":{"stream.ttff_ms":180,"saw_first_frame":true}}
{"kind":"camera.helper.exit","status":"error","details":{"signal":"SIGTERM","exit_code":null,"shutdown_phase":"placeholder","camera.helper_shutdown_ms":48,"placeholder_joined":false}}
{"kind":"camera.helper.exit","status":"ok","details":{"signal":null,"exit_code":0,"shutdown_phase":"surface_released","camera.helper_shutdown_ms":48,"placeholder_joined":true}}
{"kind":"helper.lifecycle","status":"ok","details":{"decision":"recycle-helper","sim.booted":false,"helper.uptime_ms":86400000}}
```

#128 stays a stall entry. `stream.producer_frame_age_ms` (time since last `onSharedMjpegFrame`) says the screen producer was fine; do not use `camera.frame_interval_ms` here — the camera helper feeds the guest virtual camera, not the screen stream.
`stream.reconnect_ms` is absent, so the 6100 ms consumer age is not a reconnect.
#103 after a good frame is `stream.state` with `status=error` and no `stream.reconnect_ms`
and no `stream.ttff_ms` (TTFF already happened on the first-frame entry). A later
recovery is a new `stream.state` with `stream.reconnect_ms` set. #143 records the
shutdown duration on both the signaled exit and the post-#161 canary; status, not the
milliseconds, says which one failed. #102 records `helper.uptime_ms` only on the recycle
entry; a still-booted `keep` is silence, not a zero.

## Privacy and export (Evan's defaults)

- **Local event log is ON by default.** It is the channel bots read. It stores enums,
  normalized coordinates, screen dimensions, versions, and coarse status -- never pixels,
  app/accessibility text, clipboard, credentials, or raw command strings with tokens.
- **Remote export is opt-in and serve-sim-specific.** Enable export only through a
  serve-sim variable (e.g. `SERVE_SIM_TELEMETRY=remote` with `SERVE_SIM_OTLP_ENDPOINT`).
  It must **never** inherit a stray generic `OTEL_EXPORTER_OTLP_ENDPOINT` from the
  environment -- that is how CI and agents would leak without asking. Unset serve-sim
  variable = no export, in CI and on a laptop.
- **On export, drop**: pixels/frames, app & accessibility text, clipboard,
  credentials/tokens/`Authorization`, raw UDIDs and device names (export a hash),
  home-directory paths (basenames only), raw WebSocket payloads, and the local-only
  absolute `x`/`y`.
- **Debug logs are separate and local.** `DEBUG=serve-sim:*` enables the namespaced
  `debug()` streams (`serve-sim:cli|helper|state|mw` in `src/debug.ts`);
  `SERVE_SIM_DEBUG_HID=1` enables per-event HID stderr. These go to the terminal of
  whoever set them and are never attached to an export. (There is no `SERVE_SIM_DEBUG`
  variable.)

## Test plan

Docs-only; the field additions above are small and additive, each at a named hook.
Prove recordability with unit tests (`bun test`) and the maintainer loop in
`AGENTS.md` (`build.ts` -> run from `dist/` -> reproduce):

- Taps are built in `DeviceSession.recordTouchEvent` (`kind:"tap"`/`"drag"`), not
  `eventLogEventForHidMessage` (whose `0x03` branch yields `kind:"touch"` and is only
  reached for an orphan `end` or unknown `type`). So in a `DeviceSession` test (fake `hid`, as in
  `src/__tests__/device-session-lifecycle.test.ts`), send `0x03` `{type:"begin",…}`
  then `{type:"end", x, y, source:"cli", remapped:false}` over a fake socket passed to
  `attachHidSocket` (which feeds the private `handleHidMessage`), and
  read the `kind:"tap"` entry: `details.source:"cli"`; omitting `source` -> `"unknown"`; assert
  `coord_space`, `orientation`, `frame`, `remapped`, and `screen` are present.
  A landscape miss records `input.send_ms`; `hid.state=gone` and `ack=timeout` omit it;
  `input.shadowed=true` still records it.
- A `device-session` test: record a tap, deliver a differing `onSharedMjpegFrame`
  seed -> `updateEventLogEvent` sets `screen_changed:true`; an identical seed -> `false`.
- `src/__tests__/device-hub-input.test.ts` already covers `isDeviceHubInputShadowed`;
  add that a shadowed session stamps the shadow state on the session/inject entry.
- Assert `recycle-self` in middleware (`readServeSimStates` / `classifyStaleState`) can record a `helper.lifecycle` entry readable via `GET /api/event-log`; `keep` records nothing. Do not pin this to `onExit` in `helper-lifecycle.test.ts` (that path `process.exit(0)`s).
- Stream: a `producer_live` stall does not set `stream.reconnect_ms`; a return to
  `live` does. First frame sets `stream.ttff_ms`; a never-connected preview does not.
- Read-back: `GET /api/event-log` and `serve-sim event-log --json` return the new
  fields and a `schema_version`.
