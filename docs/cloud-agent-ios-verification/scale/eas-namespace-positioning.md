# Scale positioning: EAS Simulator, BYO Mac, and Namespace

**Status:** positioning essay; drafted 2026-09-23 PT  
**Fundamentals status:** the shipped fundamentals guide is **Demo Bot Excellent / SHIP**.  
**Audience:** teams deciding how a cloud agent should verify or build iOS software.

> **Start with the shipped path:** [Linux cloud agent → Mac serve-sim fundamentals](../cursor-cloud-ios-verification.md) (**SHIPPED Excellent**). This document is a separate scale-positioning layer, not a replacement or extension of that guide's verification procedure.

## The positioning in one sentence

serve-sim is a local-first, BYO-Mac preview and control surface—not a Mac-rental business. At scale, it sits beside hosted options: use **EAS Simulator** when Expo can provide the cloud simulator, use the **fundamentals BYO Mac + tunnel path** when you already have Mac access, and use **Cursor Self-Hosted / Namespace** when the agent itself must execute on Apple silicon.

That distinction matters. A remote simulator preview and a remote Mac worker solve different problems. serve-sim can make a simulator on a developer's or teammate's Mac observable and controllable from elsewhere; it does not provision a fleet of Macs. The maintainer's product constraint is explicit: do not turn serve-sim into a Mac cluster or imply that it is one.

## Three paths, three jobs

### EAS Simulator: the zero-Mac path for eligible Expo projects

EAS Simulator is the natural hosted path for a Linux or Cursor cloud agent that needs to verify an Expo app without arranging a Mac. Expo operates the simulator infrastructure; the agent uses EAS authentication and the simulator tooling. The preferred agent-facing route is the **`agent-device`** path: start an iOS session, then drive it with `agent-device` commands such as snapshots, presses, fills, screenshots, recordings, and gestures.

This is a strong fit, but it is not a universally available public utility. As of this research pass, EAS Simulator is **limited access / waitlist** rather than included automatically with free or paid EAS plans. Access is account-dependent, and public pricing for Simulator is not yet a simple published line item. Check availability before designing a workflow around it; do not present it as guaranteed capacity or quote a fixed public price.

There is also an important serve-sim relationship. In the EAS REST API, `type: "serve-sim"` corresponds to the CLI's **`web-preview-only`** mode. That mode returns a web preview and does not provide a controller. Other iOS session types can expose a web preview alongside the agent-device service. In other words, EAS is already a hosted consumer of the serve-sim preview surface in the relevant web-preview path. That is a complementary relationship, not evidence that serve-sim operates EAS's Macs or replaces EAS's agent controller.

Use EAS when the project is Expo-aligned, the account has access, and the job is primarily cloud verification of an already runnable app. Be candid about the boundaries: availability, pricing, camera behavior, Duo-specific behavior, and parity with local serve-sim controls should be verified per workflow rather than assumed.

### BYO Mac + tunnel: the fundamentals path

The fundamentals path remains the clearest option when a team already has a Mac: a developer Mac, a teammate's Mac, or another Mac the team controls. The agent stays on Linux, while serve-sim runs beside the iOS Simulator on the Mac and exposes preview/control through a tunnel. This preserves the useful local-first model and avoids a serve-sim-operated fleet.

Choose this path when the requirement is to **drive and observe** a simulator remotely, especially when the team wants serve-sim's preview experience or needs a local app, custom simulator state, or capabilities not established in the hosted EAS path. The tradeoff is operational ownership: the Mac must be awake, reachable, and secured; the tunnel is part of the deployment; and the current stock serve-sim CLI/skill is Mac-local rather than a turnkey Linux remote client. The shipped fundamentals guide documents the proven remote client and its security caveats.

This path is not a build service. If the cloud agent must run `xcodebuild` itself, the build still has to happen on a Mac-side process or a different build service. That is the dividing line between “agent verifies a Mac-hosted simulator” and “the agent is a Mac worker.”

### Namespace / Cursor Self-Hosted Mac: the in-agent Apple-silicon path

Namespace is a hosting partner for Cursor Self-Hosted Machines / Team Pools, not a serve-sim feature and not a separate Cursor product called “Namespace.” A self-hosted worker can be an Apple-silicon Mac Devbox from Namespace or a Mac the team connects through Cursor's self-hosted machinery. The Cursor agent runs **on that Mac**.

Choose this path when the agent must have native Xcode, `xcodebuild`, `simctl`, signing tools, or other macOS build dependencies inside its own execution environment. Cursor Self-Hosted / Team Pools are an **Enterprise** path, and the Mac host has its own usage cost and operational terms. Namespace supplies Mac capacity; it does not make serve-sim a hosted Mac provider.

Namespace is complementary to serve-sim. A team may run serve-sim locally on the same Mac for a richer preview/control surface, but the reason to choose Namespace is colocating the agent and the build system—not renting a serve-sim preview. If in-agent compilation is not required, moving the whole agent onto a Mac can be unnecessary overhead compared with EAS or a BYO Mac tunnel.

## Decision matrix

| Need / constraint | Choose | Why | Be honest about |
|---|---|---|---|
| Expo app; no Mac; account has EAS Simulator access; agent needs cloud verification | **EAS Simulator**, preferably the `agent-device` path | Expo hosts the simulator and provides an agent-oriented controller | Limited-access / waitlist status, account limits, and pricing; not every local serve-sim capability is equivalent |
| Expo app; no Mac; account is not enabled for EAS Simulator | **Do not promise EAS**; use a team-controlled Mac + tunnel or another hosted provider | The waitlist is a real product constraint, not a documentation detail | serve-sim does not fill the gap by renting Macs |
| Team already owns or can reach a Mac; agent needs to observe and drive a running simulator | **BYO Mac + tunnel** — the [fundamentals path](../cursor-cloud-ios-verification.md) | Lowest product commitment and preserves local app/simulator control | Mac uptime, tunnel security, network latency, and Mac-local CLI limitations |
| Agent must run `xcodebuild`, `simctl`, signing, or native macOS tooling in its own worker | **Cursor Self-Hosted Mac / Namespace** | The agent process and Apple toolchain are colocated on Apple silicon | Enterprise requirement and separate Mac-host cost; this is not a serve-sim Mac fleet |
| Agent runs on a Namespace Mac and needs a human/agent-friendly simulator preview | **Namespace plus optional local serve-sim** | The layers complement each other: Namespace hosts execution, serve-sim hosts preview/control | serve-sim is optional; Namespace is chosen for in-agent builds |
| Need a general non-Expo hosted Xcode environment | **Evaluate a purpose-built remote-Xcode provider** | Different requirement from serve-sim's preview/control layer | Do not infer support or parity from the EAS integration |

A useful shortcut is: **verify from Linux → EAS if enabled, otherwise BYO Mac; build from the agent → Self-Hosted Mac / Namespace.** If both build and preview matter, combine the layers rather than asking one product to impersonate the other.

## How this relates to the shipped fundamentals path

The fundamentals guide is the operational proof for the BYO Mac + tunnel case, and it remains the source of truth for that setup. It is intentionally not a scale essay and should not be turned into a second product comparison or a hosted-Mac promise. This document adds only the surrounding choice architecture: EAS is the preferred zero-Mac option when access exists; Namespace is the Enterprise option when the agent must run on a Mac; serve-sim remains the local/BYO-Mac preview engine between them.

The practical product message is therefore additive: ship and link the fundamentals path, acknowledge that EAS already consumes the serve-sim preview model in its `serve-sim` / `web-preview-only` mode, and point build-heavy Cursor workloads toward Self-Hosted / Namespace. None of those statements requires the maintainer to buy, run, or market a serve-sim Mac cluster.

## Guardrails for future docs

- Say **local-first, BYO Mac, preview/control surface**; do not say “serve-sim Mac rental,” “serve-sim cloud fleet,” or imply guaranteed hosted capacity.
- Say **EAS Simulator is limited-access / waitlist** and distinguish `agent-device` sessions from REST `type: "serve-sim"` / CLI `web-preview-only` web previews.
- Say **Namespace runs the agent on a Mac** and is an Enterprise/self-hosted path for in-agent Xcode work.
- Keep this decision matrix separate from the fundamentals verification ladder. The ladder proves one workflow; this essay explains when to select it.
