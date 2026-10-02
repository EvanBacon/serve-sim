# Linux cloud agent → Mac serve-sim (fundamentals path)

**Goal:** A Linux Cursor cloud agent verifies iOS by driving a Mac-hosted serve-sim over a tunnel (HTTP + binary WebSocket), without a Mac for the agent process.

**Status:** Demo Bot **Excellent / SHIP** (2026-09-23 PT). Reviews: [grading/](grading/PASS.md). Scale positioning is a separate note: [EAS Simulator, BYO Mac, and Namespace](scale/eas-namespace-positioning.md).

**Proven evidence:** [evidence/e2e-20260923/](evidence/e2e-20260923/SUMMARY.md) (cold + warm Home → Settings on iPhone 16e).

The stock Agent Skill cannot do this from Linux. `serve-sim tap` and the other input commands read `$TMPDIR/serve-sim/server-*.json` and open that local `wsUrl`. They have no `--url`. The proof used a small WebSocket client (the `ws` package) against the tunneled preview. A minimal equivalent is inlined below. It is not a shipped tool in this tree.

## Who runs where

| Layer | Machine | Role |
|---|---|---|
| Cursor cloud agent | Linux | Speaks HTTP + binary WebSocket; collects JPEG evidence |
| serve-sim preview + helper | Mac | One port (`proxyHelpers`); MJPEG + `/helper/<udid>/ws` |
| iOS Simulator | Mac | Runs Expo Go (or your app) |
| Tunnel | ngrok (or SSH) | Mac loopback → HTTPS/WSS the Linux agent can reach |

## Prerequisites

| Item | Detail |
|---|---|
| Mac | Xcode command line tools; `xcrun simctl`; awake via `caffeinate -dims` for the session |
| serve-sim | This repo. Proof used `bun run packages/serve-sim/src/index.ts` from a checkout. `npx serve-sim@latest` works once `--help` matches the flags below. |
| Sim device | Phone preferred (proof: **iPhone 16e**). Do not take over a Duo session that a person is using. |
| App (this proof) | Expo Go `host.exp.Exponent` **55.0.27** installed on the simulator |
| Linux | Node.js 20+ (maintained LTS). The remote client depends on `ws`, not a global `WebSocket`. |
| Network | Outbound HTTPS/WSS from Linux to the tunnel. **Unauthenticated control:** stream, WebSocket, `/config`, `/ax`, and `/health` have no token. Anyone with the URL can observe and tap. Prefer an ephemeral tunnel and treat `BASE` as a secret. The serve-sim token only gates `/exec`. |

### Placeholders

| Name | Meaning |
|---|---|
| `REPO` | serve-sim checkout on the Mac |
| `UDID` | From `xcrun simctl list devices booted` |
| `PORT` | Free port ≥ 3399. Do not bind `:3200` if a human preview is already there. |
| `BASE` | Public `https://…` URL from the tunnel. Do not commit it. |

## Bring-up (copy-paste)

### 1. Mac — simulator + serve-sim

```bash
caffeinate -dims &
CAFFEINE_PID=$!

xcrun simctl list devices booted
# xcrun simctl boot "iPhone 16e"   # if needed
UDID=<booted-phone-udid>
PORT=3399

cd "$REPO"
# Top-level device is positional (not -d):
bun run packages/serve-sim/src/index.ts --detach -p "$PORT" -q "$UDID"

# Rung A — Mac process/port
curl -sS "http://127.0.0.1:${PORT}/helper/${UDID}/health"
# Expect JSON / 200

xcrun simctl launch "$UDID" host.exp.Exponent
```

If taps later appear in the event log but the UI does not change:

```bash
bun run packages/serve-sim/src/index.ts repair-input -d "$UDID"
bun run packages/serve-sim/src/index.ts -k "$UDID" -q
bun run packages/serve-sim/src/index.ts --detach -p "$PORT" -q "$UDID"
```

### 2. Tunnel

Keep ngrok (or the SSH forward) alive for the whole session. A short shell that exits will take the tunnel down with it.

```bash
ngrok http "$PORT"
# BASE = public_url from http://127.0.0.1:4040/api/tunnels
```

| Contract | Value |
|---|---|
| Protocol | HTTPS to loopback HTTP; WSS to `/helper/<udid>/ws` |
| Target | Preview port only (standalone serve-sim already sets `proxyHelpers`) |
| Auth inside serve-sim | None for stream and the control WebSocket |
| Sleep | Mac sleep stops frames and HID. Keep `caffeinate`; reopen the stream after wake. |
| URL rotate | A free ngrok URL changes on restart (`ERR_NGROK_3200` means the old URL is dead). Refresh `BASE`. |

### 3. Linux — attach

`BASE` is the ephemeral tunnel URL. Send `ngrok-skip-browser-warning: 1` on free ngrok so the agent does not receive the browser interstitial.

```bash
BASE=https://YOUR_TUNNEL.example
UDID=<same-udid>

# Rung B — tunnel from Linux
curl -fsS -H 'ngrok-skip-browser-warning: 1' "$BASE/helper/$UDID/health"
curl -fsS -H 'ngrok-skip-browser-warning: 1' "$BASE/helper/$UDID/config"
# Expect HTTP 200. Wait until config width and height are non-zero.
```

### 4. Minimal remote client

The proof client spoke the same binary frames as `serve-sim tap`: tag `0x03`, then UTF-8 JSON, with `begin`, a 40 ms gap, and `end` on one socket. Install `ws` in a scratch directory. Do not commit `BASE`.

```js
import WebSocket from "ws";

const base = process.env.BASE;
const udid = process.env.UDID;
const headers = { "ngrok-skip-browser-warning": "1" };

function frame(tag, payload) {
  const json = Buffer.from(JSON.stringify(payload));
  const msg = Buffer.alloc(1 + json.length);
  msg[0] = tag;
  json.copy(msg, 1);
  return msg;
}

const x = 0.815;
const y = 0.938;
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/helper/${udid}/ws`, { headers });
ws.on("open", () => {
  ws.send(frame(0x03, { type: "begin", x, y }));
  setTimeout(() => {
    ws.send(frame(0x03, { type: "end", x, y }));
    setTimeout(() => ws.close(), 50);
  }, 40);
});
```

Screenshots in the proof are the first JPEG from `GET /helper/<udid>/stream.mjpeg?raw=1` (octet-stream), not `POST /exec`. `/exec` is the token-gated host shell and is not required to observe or tap.

### 5. First interaction (rungs C–E)

Expo Go’s Settings tab. Logical layout is about 390×844 points. `/config` may report pixels (1170×2532 at 3× on this proof). Taps are normalized 0..1, so the same fractions work either way.

| Tap | Normalized x, y | Result in the proof |
|---|---|---|
| Home tab | `0.125 0.938` | Expo Go Home |
| Settings tab | `0.815 0.938` | Expo Go Settings |
| Alert Cancel (only if a system alert is up) | `0.32 0.52` | Dismiss `Open in 'example'?` |

**Observable success:** the before JPEG shows Expo Go **Home** (Home tab selected). The after JPEG shows **Settings** (Settings tab selected, client version visible). That navigation is also **rung E** (named Expo task: open Expo Go Settings).

Assert opposing tabs. Tapping the tab that is already selected yields identical JPEGs.

## Verify ladder

| Rung | Pass means | Evidence (2026-09-23 re-run) |
|---|---|---|
| A | Mac port and process | [verify-A-mac-port.json](evidence/e2e-20260923/verify-A-mac-port.json) |
| B | Tunnel from Linux | [verify-B-tunnel-from-linux.json](evidence/e2e-20260923/verify-B-tunnel-from-linux.json), [commands.log](evidence/e2e-20260923/commands.log) |
| C | Simulator and a real UI | [cold/home.jpg](evidence/e2e-20260923/cold/home.jpg) (Expo Go Home) |
| D | Before/after tap | [cold/](evidence/e2e-20260923/cold/home.jpg) and [warm/](evidence/e2e-20260923/warm/home.jpg) Home → Settings |
| E | Named Expo task | Same JPEGs: Settings shows Client Version 55.0.27. See [SUMMARY.md](evidence/e2e-20260923/SUMMARY.md). |

The original inbox also had `verify-C` / `verify-D` JPEGs and a `verify-E` note. Those JPEGs were byte-identical to `cold/home.jpg` and `cold/settings.jpg`, so they are not duplicated here.

## Timing (measured — two sessions, 2026-09-23 PT)

| Metric | First run | Re-run |
|---|---|---|
| First JPEG over the tunnel | 564 ms | 589 ms |
| Settings tap RTT | 521 ms | cold 527 ms / warm 503 ms |
| Health over the tunnel | 467 ms | 494 ms |

Re-run source: [timing.json](evidence/e2e-20260923/timing.json). These are session measurements, not an SLO.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| No frames after idle | Mac sleep | `caffeinate -dims`; reopen the stream |
| Port in use | Prior helper | Pick a free port ≥ 3399; never take `:3200` |
| `ERR_NGROK_3200` | Stale ngrok URL | Restart ngrok; update `BASE` |
| Blank stream / width 0 | Helper not ready | Wait until `/config` is non-zero; restart serve-sim |
| Taps logged, UI unchanged | Device Hub input not attached | `repair-input`, then restart serve-sim |
| Permission / TCC dialogs | First launch | Dismiss on the Mac, or with an AX lookup plus a tap |
| Pairing / helper failure | Runtime mismatch | Boot in Simulator.app; restart serve-sim |
| ngrok browser interstitial | Free-plan warning page | Send `ngrok-skip-browser-warning: 1` |
| AX 503 | `noFrontmostApplication` | Launch the app; prove the change with a JPEG delta |
| Leftover system alert | Prior `Open in 'example'?` (or similar) | Tap Cancel near `(0.32, 0.52)`, then drive Home ↔ Settings |
| Identical before/after JPEGs | Tapped the already selected tab | Assert opposing tabs |
| ngrok or caffeinate disappears | The remote shell exited | Keep both as long-lived foreground jobs |

## Teardown

```bash
cd "$REPO"
bun run packages/serve-sim/src/index.ts -k "$UDID" -q
# stop the ngrok or SSH forward you started
kill "$CAFFEINE_PID"
```

Leave any other human previews (including Duo on `:3200`) alone.

## Agent Skill

On a Mac, use the serve-sim Agent Skill (`npx serve-sim tap` and the other local commands).

On Linux, that skill cannot target the tunnel. Use the WebSocket frames above, or SSH to the Mac and run the CLI there. Prefer EAS Simulator when the account has it and the job is Expo verification without a Mac; that choice is [scale positioning](scale/eas-namespace-positioning.md), not part of this procedure.
