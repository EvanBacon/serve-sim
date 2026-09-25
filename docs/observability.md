# Observability

Design only. No SDK, exporter, or runtime change is implied by this document.

serve-sim is a local Mac process that streams a simulator and injects input. The failures that have cost time are silent: a command exits 0, `--list` says `running: true`, or the preview says Connecting while the capture side is still producing frames. The useful record is the fields that distinguish those cases, plus timings on the paths we have already had to measure by hand.

## Goals

1. **Error reproduction.** Each event below is a field that was missing from a real report. With it, a log line is enough to tell injector-sent from guest-unchanged, signal from exit 0, and a dead consumer from a dead producer.
2. **Performance timing.** Spans for the hot paths where a fix already depended on a number: first frame, inject send, camera frame interval, helper startup/shutdown, reconnect.

Both stay on the machine unless someone opts into export.

## Non-goals

- Dashboards, error budgets, release scorecards, or a feedback program.
- Shipping an OpenTelemetry SDK in the first slice.
- Guest-effect checks that keep pixels, OCR, or accessibility text.
- A default backend, a prompt, or a notice on startup.

## Privacy and opt-out

Default is **off**. Nothing is written for telemetry and nothing is sent.

| Control | Effect |
|---|---|
| unset | off |
| `SERVE_SIM_TELEMETRY=0` \| `off` \| `false` | off |
| `--no-telemetry` | off (wins over every other switch) |
| `SERVE_SIM_TELEMETRY=local` or `--telemetry=local` | JSON-lines on the machine only |
| `SERVE_SIM_TELEMETRY=1` \| `on` \| `remote` or `--telemetry=remote` | local events, plus OTLP **only** when `OTEL_EXPORTER_OTLP_ENDPOINT` is set to a URL the operator chose |

There is no config file today. A future `telemetry` key uses the same enum (`off` \| `local` \| `remote`). Precedence is CLI, then env, then file. `off` wins.

CI and agent runs stay silent. Opt-in is an explicit env or flag in that job, not something inferred from `CI=`.

`SERVE_SIM_DEBUG` and `SERVE_SIM_DEBUG_HID` stay local stderr for the person who set them. Those lines are debug logs. They are not attached to exported spans.

`--list` health (HID state, last successful inject, stream frame age) is process status for the operator sitting at the terminal. It is not an export path.

Events carry enums, timings, versions, and coarse runtime strings. They leave out:

- MJPEG, JPEG, screenshots, camera frames, and any other pixels
- App content, accessibility-tree text, clipboard
- Credentials, tokens, cookies, `Authorization` headers
- Raw UDIDs and device names on any export (see `device.id_hash`)
- Home-directory paths (basenames only)
- Raw WebSocket payloads

`device.id_hash` is 8 hex chars of SHA-256 of the UDID. Local debug may also print an 8-character UDID prefix on its own line. Remote export gets the hash only. `session.id` is a new UUID per server process.

## Common attributes

Present on every event and span:

| Field | Type | Example / notes |
|---|---|---|
| `serve_sim.version` | string | `0.1.47` |
| `serve_sim.arch` | enum | `arm64` \| `x64` |
| `os.version` | string | macOS `major.minor` only |
| `xcode.version` | string | `27.0` (marketing version, not the build serial) |
| `ios.runtime` | string | `iOS 27.0` |
| `session.id` | string | ephemeral UUID |
| `device.id_hash` | string | 8 hex chars |
| `sim.ui_host` | enum | `none` \| `simulator_app` \| `device_hub` \| `unknown` |

`sim.ui_host=none` is the headless `simctl boot` case with no Simulator.app or Device Hub.

## Error reproduction

| Issue | What the report could not show | Event |
|---|---|---|
| [#153](https://github.com/EvanBacon/serve-sim/issues/153) | Touch exits 0 and HID debug prints, screenshots identical, lock works. Missing injector health vs guest effect, runtime, UI host, client connected, send ack, coordinate space, version. | `input.inject` |
| [#136](https://github.com/EvanBacon/serve-sim/issues/136) | HID died; button, tap, and gesture still exit 0; `--list` stays `running: true`. | `hid.health` + `input.inject` |
| [#143](https://github.com/EvanBacon/serve-sim/issues/143) | Helper exit was null (signal) under `--max-concurrency=1`. Missing signal vs code, last log, shutdown phase, placeholder-timer vs socket-close timing. | `camera.helper.exit` |
| [#103](https://github.com/EvanBacon/serve-sim/issues/103) | Preview live for 1–2s, then Connecting forever on 0.1.40+. Missing state transitions, last frame time, WS close reason, first-frame vs later stall, whether it recovered. | `stream.state` |
| [#128](https://github.com/EvanBacon/serve-sim/issues/128) | MJPEG `<img>` watchdog showed a frame-stall after rotation while `/stream.mjpeg` was still sending. | `stream.stall` |
| [#102](https://github.com/EvanBacon/serve-sim/issues/102) | Helper stayed up for days after the sim was Shutdown. Closed by [#152](https://github.com/EvanBacon/serve-sim/pull/152); the booted-vs-alive pair is the canary. | `helper.lifecycle` |

### `input.inject`

One event per touch phase, button, or gesture step. This is the record [#153](https://github.com/EvanBacon/serve-sim/issues/153) and [#136](https://github.com/EvanBacon/serve-sim/issues/136) needed: `button lock` goes through `IndigoHIDMessageForButton` (target hardware, `0x33`) and can succeed while digitizer touch (`0x32`, `IndigoHIDMessageForMouseNSEvent`) is built and sent into a session with no UI host.

| Field | Type | Notes |
|---|---|---|
| `hid.client` | enum | `created` \| `missing` \| `send_unloaded` |
| `hid.state` | enum | `ok` \| `stale` \| `gone` (same enum as `hid.health`) |
| `inject.kind` | enum | `touch` \| `button` \| `gesture` \| `key` \| `rotate` |
| `inject.phase` | enum | `begin` \| `move` \| `end` \| `press` |
| `inject.result` | enum | `sent` \| `nil_message` \| `no_client` \| `throw` |
| `inject.ack` | enum | `none` until a reply exists. Later `ok` \| `timeout` |
| `inject.ack_ms` | int, ms | omitted while `inject.ack=none` |
| `inject.guest_effect` | enum | `not_checked` by default. Opt-in local `--verify` may set `changed` \| `unchanged` and then discard the frames |
| `input.coord_space` | enum | `normalized_0_1` |
| `input.screen_w` | int, px | width passed into the injector |
| `input.screen_h` | int, px | height passed into the injector |
| `input.target` | enum | `digitizer` \| `hardware_button` |
| `input.x`, `input.y` | number | local events only. Remote export omits them |
| `error.code` | string | stable token on `throw` (`hid_client_missing`, `mouse_symbol_missing`, …) |
| `cli.exit_code` | int | `0` only when `inject.result=sent` and `hid.state=ok`. `no_client`, `nil_message`, `gone`, and `throw` exit non-zero |

Today's `tap` is fire-and-forget: the socket open succeeds, `begin`/`end` are written, and the process exits 0 with no reply handler. The event records that as `inject.result=sent`, `inject.ack=none`, `inject.guest_effect=not_checked`. A sent digitizer event and a delivered one stop looking the same once `hid.client`, `sim.ui_host`, and `input.target` are on the line.

### `hid.health`

Emitted on transition and included in `--list`. [#136](https://github.com/EvanBacon/serve-sim/issues/136) stayed invisible because `running` is "pidfile exists", which stays true after the HID client is dead and after a `simctl shutdown` / `boot`.

| Field | Type | Notes |
|---|---|---|
| `hid.state` | enum | `ok` last send landed. `stale` no successful send for `hid.stale_after_ms` while commands are still arriving. `gone` client missing or sim not booted |
| `hid.last_ok_at_ms` | int | unix ms of the last `inject.result=sent`. `0` if none |
| `hid.stale_after_ms` | int, ms | threshold in force (start at 30000) |
| `hid.helper_age_ms` | int, ms | age of this helper process, not of the simulator |
| `sim.booted` | bool | `simctl` still lists the UDID as Booted |
| `list.running` | bool | today's flag, kept so `running:true` + `hid.state:gone` is one object |

### `camera.helper.exit`

[#143](https://github.com/EvanBacon/serve-sim/issues/143) failed in the test's `exitCode !== 0` branch: Node reports `null` when the child dies on a signal, and the shm name was already unlinked. The race was the placeholder timer's in-flight `PublishFrame` versus surface release (`SIGSEGV` / use-after-free, or `SIGPIPE` if a client vanished mid-write).

[#161](https://github.com/EvanBacon/serve-sim/pull/161) is on main (`516cdbf`). `StopPlaceholderSource` now cancels the timer and waits for its cancel handler before `ReleaseSurfaces`, and the helper returns 0. Issue #143 is still open; treat that as the bug being mitigated, and keep these fields as the regression canary. A future red CI run should show signal number and phase instead of `exited with null`.

| Field | Type | Notes |
|---|---|---|
| `camera.helper_exit_code` | int or null | `null` when the process is signaled |
| `camera.helper_signal` | int or null | signal number (`11` SIGSEGV, `13` SIGPIPE, `6` SIGABRT). `null` on a normal exit |
| `camera.shutdown_phase` | enum | `running` \| `unlink_shm` \| `stop_placeholder` \| `stop_video` \| `stop_webcam` \| `close_socket` \| `release_surfaces` \| `exited` |
| `camera.placeholder_joined` | bool | timer cancel handler finished before unmap |
| `camera.placeholder_join_ms` | int, ms | wait on that semaphore |
| `camera.socket_close_ms` | int, ms | shutdown request → accept source cancelled |
| `camera.source` | enum | `placeholder` \| `webcam` \| `image` \| `video` \| `none` |
| `camera.last_log` | string | last ~600 chars of helper stderr. Basenames only, no frame bytes |
| `error.code` | string | `helper_signaled` \| `helper_nonzero` \| `helper_ok` |

### `stream.state`

[#103](https://github.com/EvanBacon/serve-sim/issues/103) went live, then stuck on Connecting from 0.1.40 onward. A later note on 0.1.44: after the preview had already rendered, a browser/HID interaction flipped it back to Connecting and it never recovered, while `/stream.mjpeg` was still returning 200 and transferring megabytes. That is a consumer state-machine bug, not a dead simulator. The transition log is the repro.

| Field | Type | Notes |
|---|---|---|
| `stream.state` | enum | `starting` \| `connecting` \| `live` \| `stalled` \| `reconnecting` \| `stopped` |
| `stream.prev_state` | enum | previous value |
| `stream.saw_first_frame` | bool | false = never left Connecting; true = stall after a good frame |
| `stream.last_frame_age_ms` | int, ms | age on **this consumer**. `-1` if none yet |
| `stream.consumer` | enum | `mjpeg_img` \| `mjpeg_fetch` \| `avcc` \| `relay` |
| `stream.producer_ok` | bool | capture side has a frame newer than the stall threshold (counter only) |
| `stream.ws_close_code` | int | RFC 6455 code, `0` if the socket is open |
| `stream.ws_close_reason` | string | short token (`normal`, `abnormal`, `error`). Not the payload |
| `stream.recovered` | bool | reached `live` again after `stalled` or a second `connecting` |

### `stream.stall`

[#128](https://github.com/EvanBacon/serve-sim/issues/128) fired the overlay "Stream is not producing frames" after rotation. The native `<img src=stream.mjpeg>` and a parallel `fetch()` watchdog are separate consumers; either can time out while the other, and the helper, are healthy. The startup watchdog in `SimulatorView` is 6000 ms and keys off MJPEG `--frame` boundaries. Relay mode treats 2000 ms without a frame as stale. The event records which detector fired and whether the producer was still moving.

| Field | Type | Notes |
|---|---|---|
| `stream.stall_reason` | enum | `startup_watchdog` \| `relay_stale` \| `consumer_stalled_producer_live` \| `producer_silent` |
| `stream.stall_threshold_ms` | int, ms | timeout that fired |
| `stream.last_frame_age_ms` | int, ms | consumer frame age |
| `stream.fps` | number | frames in the last 1s on that consumer |
| `stream.producer_fps` | number | frames published in the same 1s |
| `stream.false_positive` | bool | `producer_fps > 0` while the consumer is past threshold |
| `stream.orientation` | enum | `portrait` \| `portrait_upside_down` \| `landscape_left` \| `landscape_right` |
| `stream.restart_ms` | int, ms | time until the next `live`, omitted if it never returns |

### `helper.lifecycle`

[#102](https://github.com/EvanBacon/serve-sim/issues/102) was an orphaned `serve-sim-bin` at ~100% CPU with the simulator already Shutdown (parent `launchd`, uptime measured in days). [#152](https://github.com/EvanBacon/serve-sim/pull/152) exits detached helpers after simulator shutdown. One event on the way out, and one if the process is still alive while `sim.booted=false`, is enough to catch a regression.

| Field | Type | Notes |
|---|---|---|
| `sim.booted` | bool | |
| `helper.uptime_ms` | int, ms | |
| `helper.parent` | enum | `launchd` \| `serve-sim` \| `other` |
| `helper.action` | enum | `exit_sim_shutdown` \| `still_alive_sim_down` |

## Performance timing

Durations are milliseconds. Histograms are for a later exporter; local events just store the number. Suggested buckets are upper bounds in ms.

| Span | Start → end | Fields | Buckets |
|---|---|---|---|
| `stream.startup` (`stream.ttff_ms`) | stream request accepted → first JPEG or AVCC frame delivered to that subscriber | `boot_ms` (sim already booted, else time until Booted), `ws_ms` (socket open), `indigo_ms` (first framebuffer/Indigo snapshot), `first_jpeg_ms` (encode + first byte to the subscriber). Sum is `stream.ttff_ms` | 50, 100, 250, 500, 1000, 2000, 5000 |
| `input.send` (`input.send_ms`) | handler entered → `rawSend` returned | `inject.kind`, `inject.result` | 1, 5, 10, 25, 50, 100, 250 |
| `input.roundtrip` (`input.roundtrip_ms`) | `rawSend` → ack | emitted only once `inject.ack` is `ok` or `timeout` | 5, 10, 25, 50, 100, 250, 500, 1000 |
| `camera.frame` (`camera.frame_interval_ms`) | `PublishFrame` n → n+1 | `camera.source` | 16, 33, 50, 100, 250, 1000 |
| `camera.shm_map` (`camera.shm_map_ms`) | `shm_open` → mapped header readable | `camera.shm_map_result` enum `ok` \| `enoent` \| `error` | 1, 5, 10, 50, 100, 500 |
| `camera.helper_startup` (`camera.helper_startup_ms`) | process start → first frame seq published | `camera.source` | 10, 50, 100, 250, 500, 1000, 5000 |
| `camera.helper_shutdown` (`camera.helper_shutdown_ms`) | shutdown action or signal → process exit | `camera.placeholder_join_ms`, `camera.socket_close_ms`, `camera.helper_exit_code`, `camera.helper_signal` | 10, 50, 100, 500, 1000, 5000 |
| `stream.reconnect` (`stream.reconnect_ms`) | leave `live` → return to `live` | `stream.reconnect_attempt` (int, starts at 1), `stream.stall_reason` | 100, 250, 500, 1000, 2000, 5000 |

`stream.ttff_ms` is the number the idle-floor test already budgets by hand (first JPEG after `stream.mjpeg` is opened). `camera.helper_shutdown_ms` split into placeholder-join and socket-close is the number [#143](https://github.com/EvanBacon/serve-sim/issues/143) was missing when the helper died between "running" and exit 0. `input.send_ms` without `input.roundtrip_ms` is an honest measurement of today's fire-and-forget path; round-trip appears only when an ack exists.

Crashes in our own process add `error.code` plus a stack trimmed to serve-sim frames, with home directories stripped. No media, no request bodies.

## Phased rollout

1. **Local events.** Structured JSON-lines when telemetry is `local`. Same schema as the tables above. `--list` grows `hid.state`, `hid.last_ok_at_ms`, and `stream.last_frame_age_ms` so an agent can see a dead injector without enabling telemetry. No new dependency.
2. **Optional OTLP.** When telemetry is `remote` and `OTEL_EXPORTER_OTLP_ENDPOINT` is set, export the same spans and events. Map `serve_sim.version` → `service.version`, `os.version` → `os.version`, `os.type=darwin`. Histograms use the buckets above. No endpoint is built in. Unset endpoint means stay on phase 1 even if the flag says remote.
3. **Default remains off.** Absence of the env var is off, in CI and on a laptop.

## Opt-out patterns elsewhere

Short notes on switches worth copying, and one worth avoiding. Not a survey of their event catalogs.

- **Maestro** posts anonymous analytics to PostHog and used to prompt on stdin, which hung CI. Opt-out is `MAESTRO_CLI_NO_ANALYTICS=true` ([env docs](https://docs.maestro.dev/maestro-cli/environment-variables), [prompt bug](https://github.com/mobile-dev-inc/Maestro/issues/1846)). serve-sim does not prompt.
- **Homebrew** analytics are on after an install notice, with `HOMEBREW_NO_ANALYTICS=1` or `brew analytics off` ([docs](https://docs.brew.sh/Analytics)). serve-sim stays off until asked.
- **Appium** does not document a product analytics backend. `appium:eventTimings` is in-session timing, default false ([caps](https://appium.io/docs/en/latest/guides/caps/)). XCUITest, facebook/idb, and WebDriverAgent are local processes with no product export.
- **OpenTelemetry** sends nothing until an exporter endpoint is configured. The Collector is something you run ([JS exporters](https://opentelemetry.io/docs/languages/js/exporters/)). Phase 2 follows that: opt-in flag plus an operator-supplied endpoint.
