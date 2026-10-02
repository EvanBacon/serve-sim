# Cursor "Namespace" + Self-Hosted Macs (research draft)

Sources (fetched 2026-09-23 via web search):
- https://cursor.com/blog/self-hosted-machines
- https://cursor.com/docs/cloud-agent/self-hosted
- https://cursor.com/docs/cloud-agent/self-hosted/pool
- https://cursor.com/docs/cloud-agent/self-hosted/computer-use.md
- Namespace quote in Cursor blog (Hugo Santos, CEO): Devboxes spin up real Apple-silicon Macs for Cursor Cloud Agents

## What it is (Cursor side)
- **Not a separate Cursor SKU named "namespace"** in the search results; **Namespace** is a **partner host** for Cursor **Self-Hosted Machines** / **Team Pools**.
- Cursor Cloud Agents can claim a worker in a Team Pool (e.g. pool named `ios`) that is only served by Macs.
- Workers install Cursor CLI + optional `--computer-use` (Accessibility + Screen Recording on macOS).
- Alternative: **My Machines** — connect a personal Mac as a worker.
- Linux default cloud VMs still cannot run Xcode/simctl natively; Mac workers (self-hosted or partner) are the official path for iOS builds *inside* the agent runtime.

## What Namespace provides
- Namespace Devboxes: on-demand real Apple-silicon Macs intended so Cursor Cloud Agents can build/run iOS/macOS work on Apple silicon.
- Cursor lists Namespace alongside AWS Lambda, Cloudflare, Coder, Daytona, E2B, Modal, Vercel as sandbox/partner hosts.

## Pricing
- TBD — need Namespace pricing page; Cursor Self-Hosted may be included in team plan + you pay the Mac host separately. Fill after fetch.

## Comparison axes vs serve-sim + remote Mac
| Axis | Namespace/Cursor Self-Hosted Mac worker | serve-sim tunnel to remote Mac |
|---|---|---|
| Where agent code runs | **On the Mac** (worker claims chat) | On **Linux** cloud agent; Mac only hosts sim |
| Xcode/simctl | Native on worker | Must stay on Mac; Linux uses HTTP/CLI bridge |
| Simulator drive | Computer use GUI and/or local CLI/skills | serve-sim stream + skill (if remote API exists) |
| Build IPA/app | Native xcodebuild on Mac worker | Still needs Mac build (or Limrun-style remote xcode) |
| Cost model | Cursor plan + Namespace Mac minutes | Your Mac + tunnel; free software |
| Latency | Agent colocated with sim | Network RTT for every tap/frame |

## Adjacent competitors
- **Limrun**: Linux agent CLI builds on remote Xcode + drives cloud iOS sim; signed stream URL; agent skill. Closest productized "Linux agent ↔ Mac sim" SaaS.
- **RocketSim**: Local Mac Simulator CLI + skill; does not host Macs for Linux agents.
- **Xcloud**: (user mentioned) Mac env for cloud agents — verify separately.
- **agent-device (Callstack)**: remote device clouds — verify separately.

## Preliminary recommendation (pending E2E + pricing)
- **For Cursor-native iOS verification where the agent should *build* on Apple silicon:** use Self-Hosted Machines / Team Pool `ios` with Namespace (or My Machines). serve-sim is then optional local preview on that same Mac.
- **For Linux-only cloud agents that only need to *drive* an already-built app:** serve-sim remote/tunnel (or Limrun) is the fit — *if* CLI/API works over the tunnel without Mac-local TMPDIR.
- **Do not position serve-sim as a replacement for Namespace** (different layer); document both and when to combine.

## Update
See the full comparison: [cloud-ios-verification-comparison.md](cloud-ios-verification-comparison.md) (includes EAS Simulator and the recommendation).
