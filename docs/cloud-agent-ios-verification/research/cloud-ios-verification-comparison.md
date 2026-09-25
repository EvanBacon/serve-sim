# Cloud-agent iOS verification: landscape & recommendations

**Status:** research note published with the fundamentals guide. Drafted 2026-09-23 PT. No product code in this note.  
**Audience:** serve-sim maintainer.  
**Constraint:** do **not** buy/run a Mac cluster; prefer smooth integration so people verify iOS from anywhere and run parallel tracks.

## Executive summary

| Option | What it is | Best for | Mac ownership | Agent surface |
|---|---|---|---|---|
| **EAS Simulator** | Expo-hosted remote iOS/Android sims | Linux/Cursor cloud agents verifying Expo apps | Expo runs Macs | `agent-device` / Argent / Appium + iOS `webPreviewUrl` (**serve-sim**) |
| **serve-sim + tunnel / your Mac** | Local OSS stream + WS control | Dev-first iteration; BYO Mac; testing hosted infra locally | You (or a friend) | serve-sim CLI + skill; HTTP preview |
| **Cursor Self-Hosted + Namespace** | Agent *runs on* a Mac Devbox | Full xcodebuild + sim **inside** the agent VM | Namespace (paid) | Native shell + computer-use; optional local serve-sim |
| **Limrun** | SaaS remote Xcode + iOS sim | Linux agents that need build+drive without Expo | Limrun | `lim` CLI + skill + signed stream |
| **RocketSim** | Local Mac Simulator CLI + skill | Agents already on a Mac | You | Local only |
| **agent-device** | OSS device controller | Controller layer (used by EAS) | N/A | AX tree / press / screenshot |

**Recommendation for serve-sim:** position as **local / BYO-Mac / preview engine**, not as a hosted Mac fleet. **Document EAS Simulator as the preferred zero-Mac cloud path** (Expo already mounts serve-sim for iOS browser preview). Optionally add a short “EAS / hosted preview” doc that points at Expo’s skill + REST `type: serve-sim`. Do **not** compete with Namespace or EAS on Mac rental. Keep Duo lean-preview (no dual 3000 + MSAA 4× always-on) so hosted previews stay cheap.

---

## 1. EAS Simulator (Expo)

### What it is
Remote iOS Simulator / Android Emulator on **EAS infrastructure**, driven from CLI, REST API, AI agents, or browser. Explicitly marketed for **Cursor cloud agents** and other Mac-less sandboxes.

Docs:
- https://docs.expo.dev/preview/eas-simulator/introduction/
- https://docs.expo.dev/preview/eas-simulator/run-and-control.md
- https://docs.expo.dev/preview/eas-simulator/rest-api.md
- https://docs.expo.dev/preview/eas-simulator/cli-reference.md
- Marketing: https://expo.dev/services/simulators
- Agent skill: https://github.com/expo/skills/blob/main/plugins/expo/skills/eas-simulator/SKILL.md

### Availability & pricing
- **Limited-access preview.** Docs: *not included with paid or free plans*; select partners + waitlist.
- Skill text: paid EAS service; usage subject to account pricing/limits; points at https://expo.dev/pricing.
- **expo.dev/pricing (2026-09-23):** no dedicated “EAS Simulator” line item yet (Build / Workflows / Update / Hosting / Observe only). Treat **public list price as TBD**; partner accounts may bill against compute/workflow allowances.
- Check access: `npx eas-cli@latest simulator:availability --json` before starting sessions.

### How agents connect
1. Auth: `EXPO_TOKEN` in cloud/CI (no browser login).
2. `eas simulator:start --platform ios --type agent-device --non-interactive --name "…"`.
3. Drive via `eas simulator:exec npx agent-device@latest …` (verbs: `open`, `snapshot -i`, `press`, `fill`, `screenshot`, `record`, `gesture`, Metro helpers).
4. Alternatives: `--type argent` (MCP tools), `--type appium`, `--type web-preview-only`.
5. REST: `POST https://api.expo.dev/v2/device-run-sessions` with `Authorization: Bearer <Expo access token>`.

### Interaction surface vs serve-sim

| Capability | serve-sim (local) | EAS Simulator |
|---|---|---|
| Live stream / browser preview | ✓ React UI + MJPEG/H.264 | ✓ iOS `webPreviewUrl` (Android coming) |
| Taps / gestures | CLI + WS (`tap`, `gesture`) | agent-device `press` / `gesture` (AX refs) |
| Type / buttons | ✓ | ✓ (`fill`, hardware via controller) |
| Screenshots / video | Preview / simctl | `screenshot`, `record start/stop` |
| Camera injection | ✓ serve-sim camera | Not highlighted as equivalent; verify before promising |
| Logs | Browser + `event-log` | Controller `logs` / session events |
| Duo fold / 3D RealityKit | ✓ (local Mac + Xcode model) | Unclear / likely not Duo-specialized |
| Fast Refresh / Metro tunnel | Local or Expo tunnel | ✓ Mode C: Expo Go or dev client + tunnel |
| Install app | simctl / drag-drop | EAS Build id, archive URL, Expo Go, or controller install |

**Critical product link:** REST API session type `serve-sim` is what EAS CLI calls `web-preview-only`. Responses return `previewUrl` with **no controller**. Other iOS types include a web preview that (per skill summaries) runs **serve-sim alongside** the agent-device daemon. So EAS is already a **hosted consumer of serve-sim**, not a pure competitor.

### Fit for “cloud agent verifies iOS from Linux”
**Best fit among Expo-aligned options.** Matches the maintainer’s “don’t run a Mac cluster” stance: Expo hosts the Mac; Linux agent uses skill + `EXPO_TOKEN`. Parallel tracks = multiple sessions (subject to partner limits).

Gaps: waitlist; pricing opaque on public page; camera/Duo parity unknown; controller verbs differ from serve-sim skill (`press` ≠ `tap`).

---

## 2. Cursor “Namespace” / Self-Hosted Machines

### What it is
**Namespace** is a **partner host** for Cursor **Self-Hosted Machines** / **Team Pools** — not a separate Cursor SKU named “namespace.” Cursor runs the agent loop; tools execute on a worker you (or Namespace) provide. Namespace **Devboxes** include **Apple-silicon Macs** so Cloud Agents can do iOS/macOS work on-box.

Sources:
- https://cursor.com/docs/cloud-agent/self-hosted
- https://cursor.com/docs/cloud-agent/self-hosted/integrations (Namespace partner guide)
- https://cursor.com/blog/self-hosted-machines
- https://namespace.so/blog/cursor-cloud-agents-devboxes
- https://namespace.so/pricing / machine shapes

### Pricing (approx., 2026-09-23)
- **Cursor:** Self-Hosted Team Pools need **Enterprise**; you still pay model usage. Managed Cloud Agents include Cursor’s Linux VM; Self-Hosted means **you pay the Mac**.
- **Namespace macOS Devboxes** (published shapes): roughly **$0.05–$0.18+/min** prepaid depending on vCPU/RAM (e.g. 4 vCPU/7 GB ≈ $0.05/min prepaid, $0.075 overage; larger shapes higher). One-minute minimum. Separate from Cursor subscription.

### Capabilities
- Agent shell/edits/builds **on the Mac** (xcodebuild, simctl native).
- Optional `--computer-use` (Accessibility + Screen Recording).
- Team Pool e.g. `ios` routes only to Mac workers.
- **My Machines:** connect a personal Mac without Namespace (still “you own a Mac”).

### vs serve-sim + remote Mac
Different layer: Namespace moves the **agent** onto a Mac. serve-sim tunnel keeps the agent on **Linux** and only remotes the **sim UI/control**. Namespace solves build+verify colocated; serve-sim/EAS solve verify-from-Linux.

---

## 3. serve-sim remote / tunnel (current product)

README claims: host locally, over LAN, or “host on a remote mac and tunnel anywhere.” Middleware `proxyHelpers: true` + upgrade forwarding = single-port remote. LAN bind with token gating.

**Audit complete** → [remote-tunnel-audit.md](remote-tunnel-audit.md) (main @ `0a8ef14`, 2026-09-23 PT):

| Question | Answer |
|---|---|
| Linux agent via **HTTP/WS alone**? | **YES** — MJPEG, `/helper/<udid>/ws` (HID), `/ax`, `/config`, `/api` need only a tunneled URL; no `$TMPDIR`. |
| Agent Skill / CLI on Linux as written? | **NO** — `tap|gesture|type|button|fold` only read `$TMPDIR/serve-sim/server-*.json` then open local `wsUrl`; **no `--url`**. |
| Token enough for unattended tunnels? | **NO** — token gates `/exec` only; stream/WS/AX are open. Trust-the-network. |

Practical path today: the Mac hosts serve-sim (`--host` plus a tunnel). The proof Mac had **ngrok** and **ssh**, not cloudflared. Standalone already sets `proxyHelpers: true`. The Linux agent drives the **binary HID WebSocket** (or the browser preview), not the stock skill CLI. Optional future: a CLI `--url` or skill remote mode so Linux agents get the same verbs without reimplementing the protocol.

Duo note (confirmed in audit): lean RT while moving, full (~3000×) after ~180 ms settle — lean-preview work must keep settle quality without always-on dual 3000 + MSAA 4×.

---

## 4. Other adjacent tools (short)

- **Limrun:** Linux CLI for remote Xcode + iOS sim + signed stream + agent skill. Closest SaaS twin to EAS for non-Expo stacks. https://docs.limrun.com
- **RocketSim:** Local Mac only; agent skill for AX-driven local Simulator.
- **Xcloud:** User-mentioned Mac env for agents — not deep-dived this pass; treat as another Mac-hosting option if revisited.
- **agent-device (Callstack):** OSS controller used by EAS; complements serve-sim rather than replacing stream/preview.

---

## 5. Recommendations

### Positioning
1. **serve-sim = local-first + BYO-Mac + the preview engine hosts already use (EAS).** Double down on README’s “test hosted infra locally first, then tunnel / use hosted.”
2. **EAS Simulator = preferred zero-Mac cloud verification for Expo.** Document it as the cloud backend; do not try to rent Macs.
3. **Namespace / Cursor Self-Hosted = when the agent must *build* on Apple silicon inside Cursor.** Complementary; serve-sim optional on that Mac for nicer preview.
4. **Limrun = non-Expo / multi-stack remote** alternative to mention in a comparison table, not to reinvent.

### Product / docs (propose only — do not implement yet)
- Add a short doc (or README section): **“Cloud agents”** with decision tree: local Mac → serve-sim; Expo Linux agent → EAS Simulator skill; need in-agent xcodebuild → Cursor Self-Hosted / Namespace; non-Expo SaaS → Limrun.
- Explicitly document that EAS REST `type: serve-sim` / CLI `web-preview-only` is **serve-sim hosted by Expo** — own the relationship.
- Harden remote story only where EAS doesn’t cover: raw tunnel + HTTP/WS control for non-Expo apps, Duo, camera. Concrete gap for a later PR: CLI `--url` / skill remote target (audit confirmed).
- Keep Duo lean preview so EAS/hosted streams stay affordable.

### Issue/PR?
- **Issue yes (when ready to publish):** “Document cloud-agent paths: EAS Simulator + Self-Hosted Mac + tunnel.”
- **Code PR:** only after remote-CLI audit proves a concrete gap (e.g. remote URL target for CLI). Prefer docs + skill cross-links first.

### Feasibility verdict (cloud agent ↔ sim)
| Path | Feasible today? |
|---|---|
| Linux Cursor agent → **EAS Simulator** | **Yes** (if account on waitlist/partner); designed for this |
| Linux Cursor agent → **serve-sim tunnel** to BYO Mac | **YES for HTTP/WS** (custom driver); **NO for stock skill/CLI** (TMPDIR-only, no `--url`) |
| Cursor agent on **Namespace Mac** + local serve-sim | **Yes** (Enterprise + Mac minutes) |
| serve-sim as a **hosted Mac fleet** | **No** — out of scope given that constraint |

