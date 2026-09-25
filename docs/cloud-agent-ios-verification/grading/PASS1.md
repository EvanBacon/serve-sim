# Pass 1 — serve-sim-cloud-ios-e2e-20260923 (constructive)

**Domain:** docs · **rubric:** docs-guides.md + serve-sim-cloud-ios-verify.md · **Fundamentals-First:** true · **Iter:** 1

**Claim under test:** Linux Cursor cloud agent verified iOS via Mac-hosted serve-sim over ephemeral ngrok (HTTP + binary WebSocket); Expo Go on iPhone 16e Home→Settings; proven twice 2026-09-23 PT with cold+warm visual confirms; ladder A–E; no EAS/Namespace scale essay.

## Fundamentals checklist (docs)
- [x] **Goal clarity** — lede: “A Linux Cursor cloud agent verifies iOS by driving a Mac-hosted serve-sim over a tunnel…”
- [x] **Prereqs explicit** — Mac/Xcode/simctl/caffeinate; serve-sim checkout; iPhone 16e; Expo Go 55.0.27; Node≥18 + `ws`; network + unauth control warning
- [x] **Copy-paste steps** — ordered Mac → tunnel → Linux attach → tap/shot; placeholders UDID/PORT/BASE defined once
- [x] **Observable success** — before=Home / after=Settings (tab + Client Version 55.0.27)
- [x] **Failure modes** — sleep, port, stale ngrok, blank stream, HID repair, TCC, AX 503, leftover alert, identical JPEG trap, orphaned ngrok/caffeinate
- [x] **Evidence ladder A–E** — all rungs present with dated artifacts + cold/ + warm/

## Verify ladder (spot-check)
| Rung | Artifact | Judge note |
|------|----------|------------|
| A | `verify-A-mac-port.{log,json}` | bun :3399; Duo :3200 untouched; health ok; 10:34 PT |
| B | `verify-B-tunnel-from-linux.*` + commands.log | health/config HTTP 200 from Linux over ngrok; firstFrameMs 589 |
| C | `verify-C-sim-booted.jpg` | iPhone 16e + Expo Go Home JPEG (= cold/home SHA) |
| D | `verify-D-interaction-{before,after}.jpg` + cold/ warm/ | Home→Settings visual delta ×2; SHA cold `6ae2…`→`a200…`, warm `6ae2…`→`d43a…` |
| E | `verify-E-expo-task.md` | Named Expo Go Settings nav; Client Version 55.0.27 |

## Scope gate
Guide is **single** Linux→tunnel→Mac path only. EAS/Namespace explicitly “Out of scope until Excellent.” Passes fundamentals-before-scale.

## Axes
| Axis | Score | Note |
|------|------:|------|
| Fidelity | 5 | Topology + claim match evidence; binary WS client path proven by taps |
| Technical | 5 | Bring-up order, tunnel contract, repair-input, security warning, teardown, timing.json |
| Polish | 5 | Skimmable goal→prereqs→steps→ladder→failures→teardown; screenshots are sim UI not chrome |
| Impress | 5 | Would hand to another agent with the docs repo; evidence pack is the model |

**Soft nits (non-blocking):** `/path/to/serve-sim-docs/tools` not in placeholders table (repo-relative idiom); “390×844” vs config 1170×2532 (normalized taps still correct); first-run pack not copied (re-run cold+warm supersedes).

**Pass1 proposed:** Excellent (avg 5.0)
