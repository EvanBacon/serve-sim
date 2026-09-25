# serve-sim cloud e2e — re-run summary (2026-09-23 PT)

## Overall: **PASS**

Linux cloud agent → ephemeral tunnel → Mac serve-sim on port 3399 → iPhone 16e. Expo Go Home → Settings, twice (cold and warm), over HTTP and a binary WebSocket. The tunnel URL is not retained. Duo on `:3200` was left running.

## Ladder results

| Rung | Result | Evidence in this tree |
|------|--------|------------------------|
| **A** Mac process/port alive | **PASS** | `verify-A-mac-port.json` — serve-sim on `:3399`; Duo `:3200` left alone |
| **B** Tunnel from Linux | **PASS** | `verify-B-tunnel-from-linux.json`, `commands.log` — HTTP 200 health/config |
| **C** Simulator booted + real UI | **PASS** | `cold/home.jpg` — iPhone 16e, Expo Go Home |
| **D** Interaction before/after | **PASS** | `cold/` and `warm/` Home → Settings JPEG deltas |
| **E** Expo named task | **PASS** | Settings tab shows Client Version 55.0.27 (`cold/settings.jpg`, `warm/settings.jpg`) |

`verify-C-sim-booted.jpg` and `verify-D-interaction-before.jpg` from the original inbox were byte-identical to `cold/home.jpg` (SHA-256 prefix `6ae2b63655db85ec`). `verify-D-interaction-after.jpg` was byte-identical to `cold/settings.jpg` (`a2002f6820081472`). Those duplicates are omitted. `first-frame.jpg` is the earlier capture (Settings plus an `Open in 'example'?` alert) before Cancel was tapped.

## Cold vs warm (same tunnel)

| Pass | Before | After | SHA-256 prefix |
|------|--------|-------|----------------|
| Cold | Home | Settings | `6ae2b63655db85ec` → `a2002f6820081472` |
| Warm | Home | Settings | `6ae2b63655db85ec` → `d43a79549cada3a7` |

Home shows Expo Go's dev-server list. Settings shows Theme and Client Version 55.0.27.

## Session notes

| Item | What happened |
|------|----------------|
| Port | 3399. Duo on 3200 was not restarted. |
| Visual confirms | 2 (cold + warm). An earlier same-day run had one confirm after an input repair. |
| First-frame | 589 ms on this re-run (564 ms on the earlier run) |
| Settings tap RTT | cold 527 ms / warm 503 ms (earlier run ~521 ms) |
| Pre-state | Already on Settings with an Open-in-example alert. Cancel at about `(0.32, 0.52)`, then Home ↔ Settings. |
| Input repair | `repair-input` reported input was not shadowed. serve-sim was still restarted once. Taps worked after the alert was dismissed. |
| Tunnel lifetime | The tunnel had to stay a long-lived foreground job. A short shell exit drops it. |
| Client | Small WebSocket client on Linux. Not shipped. The stock Agent Skill has no `--url`. See the fundamentals guide. |

## Security

Stream MJPEG, the control WebSocket, `/config`, `/ax`, and `/health` are unauthenticated. The tunnel was ephemeral and was stopped after the session. Do not commit tunnel URLs.
