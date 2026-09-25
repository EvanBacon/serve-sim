# serve-sim remote-hosting / tunneling audit

**Status:** research note published with the fundamentals guide. No product code changed.  
**Checkout:** this repository on `main` @ `0a8ef14` (2026-09-23 PT).  
**Audited:** 2026-09-23 ~10:17 PT.  
**Constraint:** the proof Mac's existing preview on `:3200` was left alone (observed listening; the state file for the live device pointed at `:3201`).

---

## Executive verdict (yes / no)

| Question | Answer |
|---|---|
| **Can a Linux cloud agent drive the sim via HTTP/WS alone (no Mac-local CLI / no `$TMPDIR`)?** | **YES** — if it speaks the binary HID WebSocket protocol against a tunneled preview (or helper) URL. Stream + control + AX/config are unauthenticated HTTP/WS. |
| **Can the Agent Skill run on Linux as written?** | **NO** — skill requires macOS, `npx serve-sim` CLI, and `$TMPDIR/serve-sim/server-*.json`. Input subcommands have **no `--url` / remote target**. |
| **Is token auth enough for unattended LAN/tunnel agents?** | **NO** — token only gates `/exec` (host shell). MJPEG, `/ws`, `/api`, `/ax`, `/config` are open. Binding `--host 0.0.0.0` or tunneling is trust-the-network. |

**Bottom line for Linux agents:** treat the **HTTP/WS surface** as the remote control API; do **not** expect `serve-sim tap|gesture|type|button|fold` to work from a Linux box. Host serve-sim on the Mac, tunnel one port (with `proxyHelpers` / standalone single-port), drive from Linux over that URL.

---

## 1. CLI flags for binding / host / detach / token

### Exact help text (source `packages/serve-sim/src/index.ts` via `bun run … --help`)

Relevant options (verbatim from the CLI on `main` @ `0a8ef14`):

```
-p, --port <port>                    Starting port (preview default: 3200;
                                     helper default: 3100)
--host <addr>                        Interface to bind the preview server to.
                                     Use 0.0.0.0 to expose on the LAN — only
                                     on trusted networks: the preview exposes
                                     a token-gated shell-exec route. (default:
                                     "127.0.0.1")
--detach                             Spawn helper and exit (daemon mode)
--exit-on-simulator-shutdown         Exit this process when its target
                                     simulator is no longer booted (used by
                                     --detach helpers)
```

Input commands (all take `-d, --device <udid>`; none take a URL):

```
gesture [options] <json>             Send a touch gesture
tap [options] <x> <y>                Tap at normalized 0..1 coords
button [options] [name]              Send a hardware button press
type [options] [text...]             Type text (US keyboard only)
fold [options] <deg>                 Set the iPhone Duo hinge angle in degrees
                                     (0 closed, 180 fully open)
```

**Note:** Published `serve-sim` on PATH (older build) omits some newer commands (`fold`, `repair-input`, `event-log`, `--exit-on-simulator-shutdown`, `--panes`, `--fit`, `--theme`). Source on `main` is authoritative for this audit.

### Code paths

| Concern | Path |
|---|---|
| Option registration | `src/index.ts` ~1736–1744 (`.option("-p…")`, `.option("--host…")`, `.option("--detach")`) |
| Preview bind + `proxyHelpers: true` | `src/index.ts` `serve()` ~1630–1675 — `simMiddleware({ basePath: "/", …, proxyHelpers: true })`, then `bindPreviewServer(p, middleware, host)` |
| State write for CLI | `writeState(inProcessServeSimState(udid, boundPort, "/", host))` so CLI can open same-origin `/helper/…/ws` |
| LAN hint | Logs `use --host 0.0.0.0 to expose…` when not already LAN-bound |
| Token | **Not a CLI flag.** Auto `randomBytes(32).toString("base64url")` inside `simMiddleware` (`src/middleware.ts` ~1281–1284). Injected into preview HTML as `execToken`; gates `POST {base}/exec` and `{base}/exec-ws` only. Startup log does **not** print the token. |

Help string for `--host` (source):

> Interface to bind the preview server to. Use 0.0.0.0 to expose on the LAN — only on trusted networks: the preview exposes a token-gated shell-exec route.

---

## 2. `proxyHelpers: true` + upgrade forwarding → single-port remote access

### Behavior

Standalone `serve-sim` always sets `proxyHelpers: true` (`src/index.ts` ~1637).

When `proxyHelpers` is on, `rewriteStateForRequestHost(..., proxy=true)` rewrites device URLs to **same-origin** paths on the request Host (and honors `X-Forwarded-Proto` for https/wss):

```
streamUrl → {origin}{base}/helper/{udid}/stream.mjpeg
wsUrl     → {wsOrigin}{base}/helper/{udid}/ws
```

(`src/middleware.ts` `rewriteStateForRequestHost`, ~409–455.)

Browser / remote client only needs **one** preview port. Per-device helper ports and DevTools can stay on the Mac.

### Upgrade requirement

WebSockets (HID `/helper/…/ws`, DevTools, `/exec-ws`) go through `middleware.handleUpgrade`. README (`packages/serve-sim/README.md` § Single-port / remote proxying):

> If you enable `proxyHelpers` but don't wire `upgrade`, the page still loads video over HTTP but loses simulator input and DevTools…

Embedded mounts must:

```ts
const middleware = simMiddleware({ basePath: "/.sim", proxyHelpers: true });
app.use(middleware);
server.on("upgrade", (req, socket, head) =>
  middleware.handleUpgrade(req, socket, head),
);
```

Without `proxyHelpers` (default for bare `app.use(simMiddleware)`), URLs point at the helper's own port with `127.0.0.1` rewritten to the request hostname — LAN viewers need **two** reachable ports unless you tunnel both.

---

## 3. CLI `tap` / `gesture` / `type` / `button` / `fold` — Mac TMPDIR only?

### Finding: **Mac-local TMPDIR only. Cannot target a remote URL.**

Resolution chain (`src/index.ts`):

1. `readState(deviceArg?)` → reads `$TMPDIR/serve-sim/server-{udid}.json` (`STATE_DIR = join(tmpdir(), "serve-sim")` in `src/state.ts`).
2. Opens `new WebSocket(state.wsUrl)` — typically `ws://127.0.0.1:<port>/helper/<udid>/ws`.
3. Sends binary `[tag][JSON]` frames.

There is **no** `--url`, `SERVE_SIM_URL`, or remote override in `src/index.ts` / options.

If no state file: every input command exits with  
`No serve-sim server running. Run \`serve-sim\` first.`

### Implications for Linux cloud agents

- Skill (`skills/serve-sim/SKILL.md`) prerequisites: **macOS host**, Xcode CLI, Node ≥18.
- Skill mental model and workflows shell out to `npx serve-sim tap|gesture|…` and `--list` / `$TMPDIR`.
- **As written, the Agent Skill cannot run on Linux.** A Linux agent must either:
  1. SSH/exec on the Mac and run the CLI there, or
  2. Implement the HTTP/WS protocol against the tunneled URL (recommended for cloud agents).

Live state sample on the proof Mac (port 3201 helper path; `:3200` left alone):

```json
{
  "pid": 44332,
  "port": 3201,
  "device": "6A8CD48A-FE38-43D6-B79C-30621DD2DCF1",
  "url": "http://127.0.0.1:3201",
  "streamUrl": "http://127.0.0.1:3201/helper/…/stream.mjpeg",
  "wsUrl": "ws://127.0.0.1:3201/helper/…/ws"
}
```

No `execToken` in the state file.

---

## 4. HTTP / WS surfaces a remote client can use without local TMPDIR

Assuming a tunnel (or `--host 0.0.0.0`) to the **preview** port with `proxyHelpers` (standalone default). Paths below use standalone `basePath: "/"`; embedded uses `/.sim` prefix.

### Stream / observe (no auth)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/helper/<udid>/stream.mjpeg` | `multipart/x-mixed-replace; boundary=frame`. CORS `*`. |
| `GET` | `/helper/<udid>/stream.mjpeg?raw=1` | Same JPEGs as `application/octet-stream` (fetch-friendly). |
| `GET` | `/helper/<udid>/stream.avcc` | H.264 AVCC envelopes. |
| `GET` | `/helper/<udid>/stream.3d.mjpeg` | Duo RealityKit lean/full RT preview. |
| `GET` | `/helper/<udid>/config` | `{width, height, orientation}`. |
| `GET` | `/helper/<udid>/health` | `{status:"ok"}`. |
| `GET` | `/helper/<udid>/ax` | Accessibility tree JSON. |
| `GET` | `/helper/<udid>/foreground` | Frontmost `{bundleId, pid}`. |
| `GET` | `/api` | Preview state / selection JSON. |
| `GET` | `/api/event-log` | Recent events. |
| `GET` | `/grid/api` | Device grid listing. |

Documented in `device-session.ts` header (~7–15) and routed in `middleware.ts` ~734–739.

### Control WebSocket (no auth)

`GET` upgrade → `/helper/<udid>/ws`  
Wire format: **binary frame** = `[u8 tag][UTF-8 JSON body]` (optional empty body for some tags).

#### Opcode / tag map (authoritative: `DeviceSession.handleHidMessage`)

| Tag | Direction | Payload (JSON unless noted) | Effect |
|---|---|---|---|
| `0x03` | C→S | `{type:"begin"\|"move"\|"end", x, y, edge?}` | Single touch (normalized 0..1). CLI `tap`/`gesture` use this. |
| `0x04` | C→S | `{button}` or `{button, page, usage, phase?}` | Hardware button / HID arbitrary. |
| `0x05` | C→S | `{type, x1, y1, x2, y2}` | Multi-touch. |
| `0x06` | C→S | `{type:"down"\|"up", usage}` | Keyboard (USB HID usage page 0x07). CLI `type`. |
| `0x07` | C→S | `{orientation}` | `portrait` / `portrait_upside_down` / `landscape_*`. |
| `0x08` | C→S | `{option, enabled}` | CoreAnimation debug. |
| `0x09` | C→S | *(empty)* | Memory warning. |
| `0x0a` | C→S | `{delta}` | Digital crown. |
| `0x0b` | C→S | `{dx, dy, x?, y?}` | Scroll (fractions of display). |
| `0x0c` | C→S | *(empty)* | Software keyboard toggle. |
| `0x0d` | C→S | `{width, height}` | Preferred screen size. |
| `0x0e` | C→S | `{hinge:0..180}` or `{pose:"…"}` | Duo fold / named pose; server replies `0x0e` + `{ok:bool}`. |
| `0x82` | S→C | screen config push | Seeded on connect (`WS_MSG_CONFIG`). |

Client constants also mirror touch/button/multi/crown/scroll in `SimulatorView.tsx` (`WS_MSG_TOUCH = 0x03`, etc.).

**Skill doc drift:** `skills/serve-sim/references/endpoints.md` still describes legacy binary prefixes `0x10` / `0x11`. Current in-process session uses the **JSON-tagged** channel above. Prefer `device-session.ts` over the skill endpoints page for remote agents.

### Screenshot

- **No dedicated remote screenshot HTTP API.**
- Preview UI screenshot uses `POST /exec` → `xcrun simctl io … screenshot` on the **Mac host** (requires `Authorization: Bearer <token>` and the same-origin policy).
- Remote agents should grab a JPEG from `stream.mjpeg?raw=1` (or AVCC) over the tunnel instead.

### Token-gated (not needed for drive/observe)

| Path | Auth |
|---|---|
| `POST /exec` | `Authorization: Bearer <token>`, JSON `Content-Type`, and an Origin check |
| `/exec-ws` | First message `{token}`; same Origin policy |

Token is **only** in preview HTML config (`window.__SIM_PREVIEW__.execToken`), not in TMPDIR state JSON, not printed at serve startup.

---

## 5. Token / auth for LAN exposure — enough for unattended agents?

**No.**

What the token protects:

- Host **shell execution** (`/exec`, `/exec-ws`) — dangerous if leaked; correctly gated with a Bearer token, an Origin check, and a JSON `Content-Type` (`middleware.ts` ~1892–1930).

What is **unguarded** when the port is reachable (LAN or tunnel):

- Full MJPEG / AVCC video of the simulator.
- Full HID control via `/ws` (taps, type, buttons, fold, rotate…).
- AX tree, `/api`, grid start/shutdown endpoints (grid mutations are powerful and appear unauthenticated in the same middleware surface — treat as host-trust).

Help text itself warns: use `0.0.0.0` **only on trusted networks**.  
CORS on the device session is `Access-Control-Allow-Origin: *`.

For unattended agents over the public internet you need an **external** auth layer (tunnel ACL, reverse-proxy basic/OAuth, Cloudflare Access, SSH tunnel with keys, etc.). serve-sim's token is not that layer.

---

## 6. Docs gaps vs “tunnel anywhere”

### Marketing / README claims

Opening line (`README.md`):

> Host your simulator … locally, over your LAN, or host on a remote mac and **tunnel anywhere**.

Why section:

> When you're ready to host a simulator remotely, **simply tunnel the served URL** and users can interact with the simulator as if it were running locally…

### What is spelled out

- Single-port embedding via `proxyHelpers: true` + `handleUpgrade` (good, concrete).
- `X-Forwarded-Proto` for TLS terminators.
- `--host 0.0.0.0` + token-gated shell-exec warning.
- Architecture diagram showing `$TMPDIR/serve-sim/`.

### What is **not** spelled out

- No named tunnel recipes (`ngrok`, `cloudflared`, `ssh -R`).
- No “Linux agent drives via WS” protocol cookbook (opcode table lives in code / partially outdated skill refs).
- No warning that **CLI input subcommands are Mac-local** and will not follow a tunnel from another machine.
- Skill still teaches CLI-first automation; remote HTTP path is secondary and incomplete for agents.
- Auth story undersells that **video + input are open** once tunneled.

**Gap severity for research:** high for cloud-agent workflows; low for human browser viewers (browser + tunnel works out of the box with standalone single-port).

---

## 7. Duo lean-preview language (README ↔ code)

### README (confirmed — use this wording in guides)

> Rotate animates the device and pose icons together. **Motion uses a faster render target and sharpens when settled.**  
> Screenshots capture the active app framebuffer, including the unfolded inner display.

### Code confirmation

- `DuoPreview.requestFrame(fullResolution = false)` (`duo-preview.ts`): motion frames request lean RT; after `DUO_SETTLE_MS` (**180 ms**) schedules `requestFrame(true)` for full resolution.
- `SimDuoRenderer/DuoRenderer.swift`: `targets = try [1500, 3000].map { width in … }`; `targetIndex = fullResolution ? 1 : 0`.
- Contract checklist (`.agents/skills/serve-sim-duo-verification/references/expected-behavior.md`): “1500×1350 during activity and 3000×2700 after about 180 ms idle.”

**Guide note:** README language at audit time matched this section. Detail sizes and the ~180 ms idle came from the verification contract.

Point-in-time: this section matches `main` @ `0a8ef14`. Pull request #160 later changed Duo motion to a 1000×900 target that sharpens once to 1500×1350. Use the current README and Duo verification contract for present sizes.

---

## 8. Tunnel tooling on the proof Mac (experiments)

| Tool | Available? | Notes |
|---|---|---|
| `cloudflared` | **No** | `which` / Homebrew paths: not found |
| `ngrok` | **Yes** | `/opt/homebrew/bin/ngrok` — version **3.39.8** |
| `ssh` | **Yes** | OpenSSH_10.3p1, LibreSSL 3.3.6 (`/usr/bin/ssh`) |

Practical experiment options without installing cloudflared: `ngrok http 3200` (or the live bound port) or `ssh -R` reverse tunnel. Prefer a **non-3200** port so the existing listener stays untouched.

---

## Recommended remote architecture (research)

```
[Linux cloud agent] --HTTPS/WSS--> [ngrok/ssh tunnel] --local--> [serve-sim preview :N]
                                                                   proxyHelpers: true
                                                                   /helper/<udid>/stream.mjpeg
                                                                   /helper/<udid>/ws  (HID tags)
                                                                   /helper/<udid>/ax|config
```

- Host: Mac runs `serve-sim` (or `--detach` + middleware with upgrade).
- Agent: open WS, send `0x03` tap begin/end (or full gesture sequence on one socket); poll MJPEG `?raw=1` or AX for observation.
- Do **not** ship the current Agent Skill unchanged to Linux hosts.

---

## File index (primary evidence)

| File | Why |
|---|---|
| `packages/serve-sim/src/index.ts` | CLI flags, `serve()`, `tap`/`gesture`/`type`/`button`/`fold`, `readState` |
| `packages/serve-sim/src/state.ts` | `$TMPDIR/serve-sim`, `wsUrl` shape |
| `packages/serve-sim/src/middleware.ts` | `proxyHelpers`, `rewriteStateForRequestHost`, `/exec` auth, helper routes, `handleUpgrade` |
| `packages/serve-sim/src/device-session.ts` | HTTP endpoints + HID opcode switch |
| `packages/serve-sim/src/duo-preview.ts` | settle timer / lean vs full RT |
| `packages/serve-sim/README.md` | tunnel claim, proxyHelpers docs, Duo sentence |
| `skills/serve-sim/SKILL.md` | Mac-only skill; TMPDIR-centric |
| `skills/serve-sim/references/endpoints.md` | Partial remote API docs (opcode drift) |

---

## Checklist answers (copy for parent report)

1. **CLI bind/host/detach/token** — documented above; token is middleware-internal, not a flag.  
2. **proxyHelpers + upgrade** — yes, single-port remote; upgrade required for input.  
3. **CLI remote URL?** — **No; Mac `$TMPDIR` only.**  
4. **Remote HTTP/WS without TMPDIR?** — **Yes** (MJPEG, WS opcodes, AX, `/api`). Screenshot via stream grab, not dedicated API.  
5. **Token enough for unattended?** — **No.**  
6. **Docs “tunnel anywhere”** — aspirational; proxyHelpers spelled out; CLI-local + open stream/WS underdocumented.  
7. **Duo lean-preview** — README sentence confirmed in code (`faster` lean RT → sharpen after ~180 ms settle).
