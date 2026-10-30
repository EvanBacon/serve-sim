# Observability: error repro fields and timing (design proposal)

> **Status: proposal, not implemented.** The "What the event log records today"
> and "How a client reads it back" sections describe `main`. Sections and keys
> marked **Proposed** (new `details` keys, new entry kinds, `schema_version`,
> acks for all input) do not exist yet.
>
> Source paths are relative to `packages/serve-sim/`.

serve-sim already keeps an in-memory **event log** of simulator actions. This
document proposes small, additive fields that make the silent failures
([#153](https://github.com/EvanBacon/serve-sim/issues/153),
[#136](https://github.com/EvanBacon/serve-sim/issues/136),
[#143](https://github.com/EvanBacon/serve-sim/issues/143),
[#103](https://github.com/EvanBacon/serve-sim/issues/103),
[#128](https://github.com/EvanBacon/serve-sim/issues/128),
[#102](https://github.com/EvanBacon/serve-sim/issues/102)) reproducible from the
log alone, and names the code hook that would produce each one. It builds on the
log we have: no span tree, no histograms, no OpenTelemetry SDK.

Timing lives on the same entries. A duration is an additive key (`input.send_ms`,
`stream.ttff_ms`, ...). Omit the key when the number would be a lie (false stall,
stuck Connecting, dead injector, still-booted helper). Do not invent a parent span
to carry it.

The event log is a diagnostic side-channel and must never fail the input or
command path (`notifyEventLogSubscribers` in `src/event-log.ts` already swallows
subscriber errors, and `/exec` / UI recording is wrapped in `try`).

## What the event log records today

`src/event-log.ts` keeps a bounded ring (`EVENT_LOG_MAX_ENTRIES = 500`) of:

```ts
type EventLogEntry = {
  id: number; timestamp: string;
  source: "hid" | "exec" | "ui" | "capture";
  kind: string; msg: string; summary: string;
  device?: string; action?: string;
  status?: "ok" | "error";
  details?: Record<string, unknown>;
};
```

- **HID input** -> `handleHidMessage` (`src/device-session.ts`) routes tag `0x03`
  touches to `DeviceSession.recordTouchEvent` and other tags to `recordHidEvent`
  -> `eventLogEventForHidMessage(device, tag, payload, screen)`.
  `recordTouchEvent` folds begin/move/end into one `kind:"tap"` or `kind:"drag"`
  entry whose details (`touchGestureDetails`) carry `type`, optional `phase`, `start`, `current`,
  `moveCount`, optional `edge`, and `screen = {width,height}` (`eventLogScreen()`).
  An `end` with no preceding `begin`, or an unknown `type`, falls through to a
  per-phase `kind:"touch"` entry.
- **Shell actions** -> `eventLogEventForCommand(command, {exitCode})`, from the
  `/exec` path in `src/middleware.ts`. It drops upload plumbing and never records
  token-bearing command strings.
- **UI settings** -> `recordEventLogEvent({source:"ui", ...})` in `middleware.ts`.
- **Capture** -> `kind:"duo.renderer"` entries (`recordRendererEvent` in
  `device-session.ts`), with `duo.first_frame_ms` on `ready` and repeated
  identical failures coalesced into one entry via `updateEventLogEvent` (`count`).
  This is the existing precedent for "duration as a key on the same entry".

Redaction today: printable keystrokes (tag `0x06`) record `key:"character"`,
`redacted:true`, no usage; token-bearing commands are not recorded; touches store
only **normalized** coordinates plus screen dimensions, never pixels.

## How a client reads it back

- `GET {url}/api/event-log?device=<udid>&since=<id>&limit=<n>` -> `{ events: [...] }`.
- `GET {url}/api/event-log/events` -> SSE: a snapshot, then one `{ event }` per new
  entry (`subscribeEventLog`; the browser UI reaches it through the exec-ws proxy).
- `GET {url}/api/diagnostics` (loopback only) includes the last 100 entries as
  `event_log`; `serve-sim doctor` reads it.
- CLI: `serve-sim event-log [--json] [-d <udid>] [--limit <n>]` (`eventLog()` in
  `src/index.ts`, sent with the same auth headers as other input commands).

**Access.** Loopback callers are trusted. Any other caller (non-loopback,
proxied, or rebound Host) is gated on every route by `remoteAccess`
(`src/request-trust.ts`): `403` when the server was started without
`--auth-token` / `SERVE_SIM_AUTH_TOKEN`, `401` without a valid
`Authorization: Bearer <token>` or auth cookie. Any new field below inherits this
gate; none of it may weaken it.

**Proposed:** add a top-level `schema_version` to the `/api/event-log` and SSE
envelopes so a reader can tell which of the fields below are present. Every field
is additive; older consumers ignore unknown keys.

## #153: making a touch miss reproducible

#153: a tap exits 0 and the screenshot is unchanged because the point was sent in
the wrong coordinate frame. `handleHidMessage` -> `this.hid.touch(...)` never
remaps; `SimHID.touch` expects the native portrait frame, so each client remaps
before sending. The web client uses `rawPointForDisplayPoint`
(`src/client/simulator/orientation.ts`). Since [#167](https://github.com/EvanBacon/serve-sim/pull/167)
the CLI does too: `tap()` / `gesture()` in `index.ts` call `touchInputOrientation`,
which fetches the helper `/config` (`configUrlForWsUrl` in `src/touch-remap.ts`,
same headers as the socket, 2 s timeout) and applies `cliInputOrientation` /
`displayTouchToRaw`. It sends the point unmapped when `--raw` is passed, when
`/config` returns 401/403 (with a stderr warning), on any other failure (silently),
and for foldables (`hingeDegrees` present).

So a miss is still possible (`--raw`, a refused or unreachable `/config`, a stale
`orientation`, an older CLI), and nothing in the log distinguishes it from a dead
injector.

**Proposed** keys on `tap`/`drag` `details` (built in `recordTouchEvent` /
`touchGestureDetails`):

| Field | Values | Source / hook |
|---|---|---|
| `coord_space` | `normalized_0_1` | constant; the `0x03` payload is always normalized |
| `orientation` | `portrait` \| `portrait_upside_down` \| `landscape_left` \| `landscape_right` \| `unknown` | `this.orientation`, read at record time |
| `observed_orientation` | string | polled UI orientation (see below); can lag ~1 s |
| `remapped` | bool | sender-reported key in the `0x03` JSON: whether the sender applied a remap. Omitted when the sender doesn't send it, and for Duo. |
| `frame` | `display` \| `native_portrait` | `native_portrait` when `remapped=true`, else `display` (identical when no rotation is needed) |
| `remap_expected` | bool | the viewer's remap rule applied to `observed_orientation` if present, else `orientation`. Omitted for Duo (3D projection, not `rawPointForDisplayPoint`). |
| `source` | `cli` \| `web` \| `unknown` | sender-reported key in the `0x03` JSON |
| `screen_changed` | bool | guest-effect signal (see below) |
| `input.send_ms` | number | see Timing |

A miss is `remap_expected=true`, `remapped=false`.

**`source` (cli vs web).** Both clients reach the same handler over separate
WebSockets and are recorded as top-level `source:"hid"`. Add `source:"cli"` to
the `0x03` JSON from `tap()`/`gesture()` and `source:"web"` from
`SimulatorView.tsx`; store it as `details.source`. The native `touch()` call
ignores extra keys, and older clients record `unknown`.

**Keeping orientation current.** For non-Duo devices `this.orientation` only
changes on a `0x07` rotate (`if (this.duo.hinge == null) this.orientation = ...`),
so a rotation from the Simulator menu or forced by the app is missed. Record a
separately polled `observed_orientation` (as `DuoStateMonitor.refreshOrientation`
in `duo-state.ts` does via `xcrun simctl io <udid> enumerate`). Do **not** write it
into `this.orientation` or `broadcastConfig()`: that would change how clients
remap input, which is a behavior change, not a log field.
`parseIntegratedScreenOrientations` only keys `primary`/`primary-1`; confirm what a
non-Duo device reports before reusing it.

**Did the screen change, without keeping pixels.** `onSharedMjpegFrame` sees
every frame. Keep a monotonic `frameSeq` (and optionally a cheap content seed, not
the image). Store `frameSeq` at `begin`; at `end`, record `screen_changed:true` if
it already advanced, else `false` and patch the entry with `updateEventLogEvent`
on the first later frame within a short window. This requires `recordTouchEvent`
to return the entry id (it returns `void` today) and the window timer to be
cleared in `close()`.

Example (proposed shape): portrait hit vs landscape miss, same send time.

```json
{"kind":"tap","status":"ok","details":{"source":"web","orientation":"portrait","frame":"native_portrait","remapped":true,"hid.state":"ok","inject.result":"sent","screen_changed":true,"input.send_ms":4}}
{"kind":"tap","status":"ok","details":{"source":"cli","orientation":"landscape_left","frame":"display","remapped":false,"hid.state":"ok","inject.result":"sent","screen_changed":false,"input.send_ms":4}}
```

Status stays `ok` for the miss: the injector did what it was asked.

## What an ack proves

Today only `fold` (tag `0x0e`) waits for a reply: it reads the server's `0x0e {ok}`
frame, times out at 10 s, and rejects on failure (`index.ts`). `tap`, `gesture`,
`rotate`, and `button` are fire-and-forget: write the frame, wait a 40-50 ms
timer, close the socket, exit 0 unless the socket itself failed.

**Proposed:** use the `fold` pattern for all input and record
`details.ack = ok | timeout | rejected`. Scope:

- An ack **proves** the server ran `handleHidMessage` and the native call returned.
  `NativeHid.guard()` (`src/native.ts`) catches every error from the N-API call,
  logs `[hid] <op> ignored bad input`, and returns a fallback, so a failed send
  looks successful. Record `inject.result = sent | swallowed` so #136's
  dead-injector case is visible. (`guard()` must keep swallowing: an uncaught
  throw would crash the in-process server.)
- An ack **does not prove** the guest UI reacted. That is the #153 gap, and why
  `screen_changed` is the separate signal.

## HID health and Device Hub shadowing (#136)

- **`hid.state`** (`ok` | `stale` | `gone`): HID can die while the state file and
  `--list` still say running. Derive it from the last native call result and
  surface it in `--list`.
- **Device Hub shadowing.** `src/device-hub-input.ts`
  (`isDeviceHubInputShadowed` / `warnDeviceHubInput`) detects when Device Hub owns
  input and legacy HID touches no-op, which looks exactly like #153. Record
  `input.shadowed` on inject entries. `serve-sim repair-input` remains the manual
  recovery (it restarts SpringBoard).

Look-alikes (proposed shapes):

```json
{"kind":"tap","status":"error","details":{"source":"cli","hid.state":"gone","inject.result":"swallowed","ack":"rejected","screen_changed":false}}
{"kind":"tap","status":"ok","details":{"source":"cli","orientation":"portrait","frame":"native_portrait","remapped":true,"hid.state":"ok","inject.result":"sent","input.shadowed":true,"screen_changed":false,"input.send_ms":4}}
```

A dead injector omits `input.send_ms` so it is not bucketed with a miss; a shadowed
send completed, so it keeps it. [#172](https://github.com/EvanBacon/serve-sim/issues/172)
(portrait tap silently dropped on iPhone 18 Pro / iOS 27) is told apart by the same
fields: `remapped=true` + `screen_changed=false` with `hid.state=ok` and no
`input.shadowed` points away from both a coordinate miss and #136.

## Helper lifecycle (#102)

The orphan in #102 was a detached helper still running after its simulator was
shut down. Decisions live in `src/helper-lifecycle.ts`: `classifyStaleState`
(`keep | recycle-self | recycle-helper`) and `startSimulatorShutdownWatch`
(a `setTimeout` loop). `middleware.ts` acts on `recycle-self`, `index.ts` on
`recycle-helper`, and the watch's `onExit` in `index.ts` calls `process.exit(0)`.

**Proposed:** record one `kind:"helper.lifecycle"` entry when a recycle/exit is
decided, with `decision`, `sim.booted`, and `helper.uptime_ms`. `keep` emits
nothing. An entry written right before `process.exit(0)` is only best-effort for
SSE readers. There is no separate helper binary; HID and capture run in-process
via the native addon.

## Stream and camera (#128, #143, #103)

- **#128 is a consumer false stall.** "Stream is not producing frames"
  (`src/client/simulator/SimulatorView.tsx`) fires from the client's 6 s startup
  watchdog (relay `subscribeFrame` or direct `fetch()` reader) when no first frame
  arrives; it never fires mid-stream. The watchdog targets a dead producer, but in
  #128 it fired while the producer was live. Separately, relay mode drops `live`
  (`setConnected(false)`) after 2 s without a frame. Proposed:
  `kind:"stream.stall"` with the reason and `producer_live` (from the server's
  per-endpoint `streamHealth`, which already counts frames and `last_frame_at`).
  Client-observed states need a small ingest route; until then, only
  server-side facts can be logged.
- **#143 camera helper exit.** Proposed: `kind:"camera.helper.exit"` with
  `exit_code`, `signal` (Node reports a `null` code on signal death), and
  `shutdown_phase`. `SimCameraHelper` already ignores SIGPIPE (`main.m`), so don't
  attribute exits to it; the real race was the placeholder timer vs. surface
  release (mitigated by [#161](https://github.com/EvanBacon/serve-sim/pull/161)).

## Timing

Measured at the hook that builds the entry, patched with `updateEventLogEvent` when
the end comes later. Milliseconds. A missing key means "not a duration", not zero.
All keys and entry kinds below are proposed.

| Key | Entry | Record when | Omit when |
|---|---|---|---|
| `input.send_ms` | tap / drag / button | socket write to ack (or close, while fire-and-forget) | `hid.state=gone`, `inject.result=swallowed`, or `ack=timeout`. A #153 miss and a shadowed send keep it. |
| `stream.ttff_ms` | stream start | session `start()` to first `onSharedMjpegFrame` | no frame ever arrived (#103 cold Connecting). Never write `0`. |
| `stream.reconnect_ms` | `stream.state` | consumer left `live` (relay 2 s staleness check) and returned | false stall (#128) or producer dead |
| `stream.producer_frame_age_ms` | `stream.stall` | age of last producer frame at stall | producer dead |
| `camera.helper_shutdown_ms` | `camera.helper.exit` | helper spawn to exit | still running |
| `helper.uptime_ms` | `helper.lifecycle` | helper start to recycle decision | `keep` |

## Privacy

- Never record raw typed text, clipboard contents, command strings with tokens, or
  pixels. Lengths and normalized coordinates are fine.
- Text entry today goes through `serve-sim type` as HID keystrokes (tag `0x06`,
  already redacted). There is no clipboard path in serve-sim to instrument; if one
  is added (e.g. for [#174](https://github.com/EvanBacon/serve-sim/issues/174)),
  log `payload_bytes`, `method`, and `verified_readback`, never the string.
- Remote readback stays behind the existing auth gate; nothing here adds an
  export or changes the default.
