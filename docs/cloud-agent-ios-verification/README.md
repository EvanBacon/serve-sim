# iOS verification from a Linux cloud agent

Research and evidence for driving a Mac-hosted [serve-sim](../../README.md) preview from a Linux Cursor cloud agent. The agent stays on Linux. The Mac runs the simulator and serve-sim. An ephemeral tunnel carries HTTPS and WSS.

| Path | What it is |
|---|---|
| [cursor-cloud-ios-verification.md](cursor-cloud-ios-verification.md) | Fundamentals guide. Demo Bot graded this path **Excellent / SHIP** (2026-09-23 PT). |
| [scale/eas-namespace-positioning.md](scale/eas-namespace-positioning.md) | How that path sits next to EAS Simulator and Cursor Self-Hosted / Namespace. Integration, not a Mac-rental product. |
| [research/remote-tunnel-audit.md](research/remote-tunnel-audit.md) | What a remote client can do over HTTP/WS, and why the stock Agent Skill cannot. |
| [research/cloud-ios-verification-comparison.md](research/cloud-ios-verification-comparison.md) | Landscape notes (EAS, BYO Mac + tunnel, Namespace, adjacent tools). |
| [research/cursor-namespace-notes.md](research/cursor-namespace-notes.md) | Shorter notes on Cursor Self-Hosted Machines and Namespace as a Mac host. |
| [evidence/e2e-20260923/](evidence/e2e-20260923/SUMMARY.md) | Re-run proof: Expo Go on iPhone 16e, Home → Settings, cold and warm. |
| [grading/](grading/PASS.md) | Demo Bot review notes (PASS / Excellent). |

The stock Agent Skill has no `--url`. Input commands read a Mac-local state file, so the proof used a small WebSocket client on Linux. That client is not shipped here; the guide inlines the same begin/end tap.

Tunnel hostnames, auth tokens, and home directories are omitted. The tunnels were ephemeral and were stopped after the session.
