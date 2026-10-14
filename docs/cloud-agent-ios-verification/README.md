# Driving a Mac simulator from a Linux agent

This is how I let an agent that runs on Linux (a cloud agent, a CI job, a bot in a container) verify iOS changes. It drives a simulator on a Mac running `serve-sim`. The agent never needs macOS: it speaks HTTP and one WebSocket to the Mac over an authenticated tunnel, and reads JPEG frames back for evidence.

Read it top to bottom the first time. Fill in the values from [Variables](#variables) and the commands paste as-is.

> **Depends on [PR #166](https://github.com/EvanBacon/serve-sim/pull/166)** (*Require auth for exec and remote access*). That PR adds `--auth-token` / `SERVE_SIM_AUTH_TOKEN`, `--url` / `SERVE_SIM_URL`, the `?token=` cookie bootstrap, and remote gating. It also makes the host shell (`/exec`) opt-in with `--allow-exec` and refuses to reuse a running server started with a different token. **Keep this guide in draft until #166 lands**, then pin a published version that includes those flags. Check with `node packages/serve-sim/dist/serve-sim.js --help | grep -- --auth-token`; if that prints nothing, stop — this build must not be tunneled.

## Who runs what

| Piece | Runs on | Started by |
|---|---|---|
| iOS Simulator (a dedicated, bot-owned device) | Mac | The Mac operator (a person, or an agent with a shell on the Mac) |
| `serve-sim` preview server (one port: stream, input WebSocket, API) | Mac | Mac operator |
| Tunnel (SSH, Tailscale, or ngrok) | Mac to Linux | Mac operator; SSH forwards are opened from the Linux side |
| Agent (`serve-sim` CLI with `--url`, or the WebSocket recipe below) | Linux | The agent |

For serve-sim development I use my Mac mini as the Mac. Our bot has a remote shell on it, so the bot runs the Mac steps itself. An agent with no shell on the Mac needs someone to run the Mac steps and hand it two values: the URL and the auth token (see [Handing the URL and token to the agent](#handing-the-url-and-token-to-the-agent)).

## Prerequisites

**Mac**

- Xcode with the iOS Simulator runtime you want (`xcrun simctl list runtimes`). Open Xcode once so it finishes installing components.
- Bun at the version in [`.bun-version`](../../.bun-version) if you run serve-sim from a checkout:
  `curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"`. Node 20+ for the built CLI.
- A serve-sim build that includes the auth flags. From a checkout: `bun install && bun run packages/serve-sim/build.ts`, then run `node packages/serve-sim/dist/serve-sim.js` (see [AGENTS.md](../../AGENTS.md)).
- ngrok only: `ngrok config add-authtoken <your-ngrok-authtoken>` (from the ngrok dashboard).
- Keep the Mac awake for the session: `caffeinate -dims &` (note the PID so you can kill it at teardown).

**Linux**

- Node 20+.
- Outbound HTTPS/WSS to the tunnel (ngrok, Tailscale) or SSH to the Mac.
- The serve-sim CLI from a build that includes #166 (`npx serve-sim@<version-after-#166>`, or a checkout of that branch: `bun install`, then `node packages/serve-sim/dist/serve-sim.js ...`). Until #166 is published, prefer the [direct WebSocket recipe](#direct-websocket-recipe) with the `ws` package.

## Variables

| Name | Where it comes from |
|---|---|
| `SIM` | Name of the bot's simulator, e.g. `bot-sim`. Create it once (below). |
| `UDID` | Printed by `xcrun simctl create`; also `xcrun simctl list devices | grep "$SIM"`. |
| `PORT` | A free port on the Mac. Don't reuse a port a person's preview holds (the default is 3200). |
| `TOKEN` | A random secret you generate on the Mac: `TOKEN=$(openssl rand -hex 24)`. |
| `URL` | The tunnel's public base URL (ngrok/Tailscale), or `http://127.0.0.1:$PORT` through an SSH forward. Treat it as a secret with ngrok. |

## Authenticated tunnels only

The preview server gates every non-loopback route behind `--auth-token`. Still, the tunnel is the outer fence; pick one that only your agent can reach:

1. **SSH local forward (preferred).** No public surface at all. From Linux:
   `ssh -N -L "$PORT:127.0.0.1:$PORT" mac-user@mac-host`. Then `URL=http://127.0.0.1:$PORT`. Over an SSH local forward serve-sim sees a loopback client, so your SSH access is the access control; still start serve-sim with `--auth-token` so the same commands work unchanged over any tunnel.
2. **Tailscale (preferred for long-lived).** On the Mac: `tailscale serve --bg "$PORT"`; URL = the `https://<mac>.<tailnet>.ts.net` address it prints. Restrict with tailnet ACLs. (serve-sim binds to loopback, so the tailnet IP alone won't reach it.)
3. **ngrok with auth.** `ngrok http "$PORT"` gives an HTTPS URL. serve-sim's `--auth-token` is what actually protects it; keep the URL out of git and chat. Free ngrok injects a browser warning — send `ngrok-skip-browser-warning: 1` on every request. ngrok forwards from loopback with `X-Forwarded-For`, which serve-sim treats as remote, so the token is enforced.

### What #166's local-only check refuses through a tunnel

serve-sim decides "local" from the socket alone (`isTrustedLoopback` in `src/request-trust.ts`): the TCP peer must be loopback (`127.0.0.0/8` / `::1`), the request must carry **no** forwarding headers (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, `CF-Connecting-IP`, `Tailscale-*`, `ngrok-*`, …), and `Host` must name a loopback host. Forwarding headers are never trusted; their presence makes the request remote.

A proxy that adds those headers — **nginx with the usual `proxy_set_header X-Forwarded-For` / `X-Real-IP`**, ngrok, Tailscale Serve — is therefore remote, even though it connects from loopback. With `--auth-token` it still gets everything this guide uses:

- the preview page (via the `?token=` cookie bootstrap), `/api`, `/api/event-log` and its SSE stream;
- `/helper/<udid>/stream.mjpeg`, `stream.avcc`, `config`, `health`, `ax`, `foreground`, and the HID WebSocket `/helper/<udid>/ws`;
- on `/exec-ws`, SSE subscriptions and simulator settings.

It is refused, with or without the token:

- `POST /exec` and shell commands on `/exec-ws`. `/exec` is off unless the server was started with `--allow-exec` (403 `exec disabled; start with --allow-exec`); with it on, a remote caller gets 403 `exec is only available to loopback clients` (exit 126 on `/exec-ws`).
- The exec token. No HTTP response ever contains it; it lives only in `$TMPDIR/serve-sim/exec-tokens/<port>.token` (0600) on the Mac, for `serve-sim exec`.
- Preview host actions (screenshot, camera, permissions, uploads, app install, location, …): `host actions are only available to loopback clients`.

**`ssh -R`, `socat`, and a proxy that strips forwarding headers are *not* refused.** They deliver a remote client from a loopback socket with no forwarding headers, which is indistinguishable from a local one, so serve-sim treats it as trusted loopback: no auth token needed, host actions allowed. (`/exec` would still need `--allow-exec` plus the token file, which the remote side can't read.) Don't use those to expose the port. `ssh -L` from the agent's machine is fine: only people with SSH access to the Mac reach it. **Never start a tunneled serve-sim with `--allow-exec`**; a remote agent never needs it, and every step here works without it.

Do not expose the port without a token, and do not pass the token in a URL query except the one-time browser cookie bootstrap (`<URL>/?token=...`), which the server immediately redirects away.

## One-time: a dedicated bot simulator

Give the bot its own device so it never fights a person's session.

```bash
# Pick a runtime and device type you have (see `xcrun simctl list`).
SIM=bot-sim
UDID=$(xcrun simctl create "$SIM" "iPhone 16" "com.apple.CoreSimulator.SimRuntime.iOS-18-0")
xcrun simctl boot "$UDID"
```

Reuse that `UDID` afterwards. Delete it with `xcrun simctl delete "$UDID"` when you retire the bot.

## Mac: start serve-sim

```bash
caffeinate -dims & CAFFEINE_PID=$!
PORT=3599                       # a free port that isn't someone's preview
TOKEN=$(openssl rand -hex 24)   # the shared secret

cd <serve-sim-checkout>
```

`--detach` prints one line of JSON and exits, leaving the helper running. **Read the port back from that JSON** rather than assuming it; serve-sim picks the next free port if `PORT` is taken.

Stop any server already running for this device first with `serve-sim -k "$UDID"`. `-k <udid>` reads that device's state file in `$TMPDIR/serve-sim/`, stops the recorded serve-sim process and any serve-sim process still holding its recorded port, then deletes the state file and the port's exec token file. It prints `{"disconnected":true,"device":"<udid>"}` whether or not anything was running, so it's safe to run every time. You need it because `--detach` reuses a running server for the same UDID, and with #166 it refuses (exit 1) when that server's settings differ from this start: `…was started with a different --auth-token` (your fresh `TOKEN` never matches), `…was started without an --auth-token`, or `…was started with --allow-exec, but it was not given now`, each followed by ``Stop it with `serve-sim -k <udid>` ``. Leave `--allow-exec` off. Run this once:

```bash
node packages/serve-sim/dist/serve-sim.js -k "$UDID" -q
PORT=$(node packages/serve-sim/dist/serve-sim.js --detach -p "$PORT" --auth-token "$TOKEN" "$UDID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["port"])')
test -n "$PORT" || { echo "serve-sim --detach failed; see the error above" >&2; exit 1; }
```

Sanity-check locally (loopback needs no token):

```bash
curl -fsS "http://127.0.0.1:$PORT/helper/$UDID/health"   # {"status":"ok"}
```

## Mac: open the tunnel

Keep whichever tunnel you chose alive for the whole session (a shell that exits takes it down). For ngrok:

```bash
ngrok http "$PORT"              # URL = the https forwarding URL it prints
```

For SSH, open the forward from Linux instead (previous section) and use `URL=http://127.0.0.1:$PORT`.

## Handing the URL and token to the agent

The agent needs exactly: the tunnel URL, the auth token, and the UDID. Pass them as environment variables to the agent process, or write them to a file the agent reads. Never commit them.

If you have no shell on the Mac, ask the operator for exactly: (1) URL — or SSH user@host and PORT if you'll open the forward, (2) TOKEN, (3) UDID, (4) confirmation that the Mac-side `/health` check printed `{"status":"ok"}`. Pass all of them out-of-band, never in a commit or PR comment.

Export the same names the CLI and the WebSocket recipe both read:

```bash
# On the Linux agent:
export SERVE_SIM_URL="$URL"
export SERVE_SIM_AUTH_TOKEN="$TOKEN"
export UDID="<same-udid>"
```

## Linux: attach and verify

```bash
# ngrok free also needs: -H 'ngrok-skip-browser-warning: 1'
# Expected: {"status":"ok"} within a few seconds; retry on connection refused.
curl -fsS --max-time 10 -H "Authorization: Bearer $SERVE_SIM_AUTH_TOKEN" "$SERVE_SIM_URL/helper/$UDID/health"
# Expected: JSON with non-zero width/height once the helper is ready.
curl -fsS --max-time 10 -H "Authorization: Bearer $SERVE_SIM_AUTH_TOKEN" "$SERVE_SIM_URL/helper/$UDID/config"
# Wait until config width/height are non-zero before driving input.
```

## Linux: drive it with the CLI

**Requires #166.** Until that PR is published, skip this section and use the [direct WebSocket recipe](#direct-websocket-recipe) instead — on mainline builds, `tap`/`button`/`event-log` only read a Mac-local state file and cannot target a remote URL.

With a #166 build and `SERVE_SIM_URL` / `SERVE_SIM_AUTH_TOKEN` set:

```bash
serve-sim tap 0.5 0.9 -d "$UDID"       # fire-and-forget; confirm with event-log or a JPEG delta
serve-sim button home -d "$UDID"
serve-sim event-log -d "$UDID"         # read back what the device received
```

Grab a JPEG for evidence (first complete MJPEG part — `?raw=1` does **not** strip multipart framing):

```bash
curl -sSN --max-time 5 -H "Authorization: Bearer $SERVE_SIM_AUTH_TOKEN" \
  "$SERVE_SIM_URL/helper/$UDID/stream.mjpeg" | python3 -c '
import sys,re
b=sys.stdin.buffer.read()
m=re.search(rb"Content-Length: (\d+)\r\n\r\n",b)
if not m: raise SystemExit("no MJPEG part")
sys.stdout.buffer.write(b[m.end():m.end()+int(m.group(1))])' > before.jpg
file before.jpg   # expect: JPEG image data
```

## Direct WebSocket recipe

When you don't want the CLI, drive input over one WebSocket. This matches what the server actually handles, verified against a running server:

- Connect to `<ws-base>/helper/<UDID>/ws` (`ws://` or `wss://`), where `<ws-base>` is `SERVE_SIM_URL` with the scheme swapped to ws/wss.
- Each input is **one binary frame**: a 1-byte tag, then UTF-8 JSON.
- The tags the server handles are `0x03`-`0x0e` (see [the full list](../../skills/serve-sim/references/endpoints.md#websocket-message-types)). There is no 0x10/0x11 binary-struct format and no `serve-sim-client/touch-codec` package.
- The server pushes a config frame (first byte `0x82`) once the screen size is known and on every change; **wait for it before sending input**.
- A tap is `0x03` `begin` then `0x03` `end` on the same socket, ~40 ms apart. `x`/`y` are normalized `0..1`.

```js
// Save as tap.mjs; run: npm i ws && node tap.mjs
// env: SERVE_SIM_URL, SERVE_SIM_AUTH_TOKEN, UDID (as exported above)
import WebSocket from "ws";

const wsBase = process.env.SERVE_SIM_URL.replace(/^http/, "ws");
const headers = {
  Authorization: `Bearer ${process.env.SERVE_SIM_AUTH_TOKEN}`,
  // ngrok free only:
  // "ngrok-skip-browser-warning": "1",
};

function frame(tag, payload) {
  const json = Buffer.from(JSON.stringify(payload));
  return Buffer.concat([Buffer.from([tag]), json]);
}

const ws = new WebSocket(`${wsBase}/helper/${process.env.UDID}/ws`, { headers });
// The server only sends 0x82 once the screen size is known; don't hang forever.
setTimeout(() => { console.error("no config frame in 10s"); process.exit(1); }, 10_000).unref();

let sent = false;
ws.on("message", (data) => {
  const buf = Buffer.from(data);
  if (buf[0] !== 0x82) return; // ignore other server frames
  console.error("config", JSON.parse(buf.subarray(1).toString("utf8")));
  if (sent) return;
  sent = true; // first config = screen is ready
  const x = 0.5, y = 0.9;
  ws.send(frame(0x03, { type: "begin", x, y }));
  setTimeout(() => {
    ws.send(frame(0x03, { type: "end", x, y }));
    setTimeout(() => ws.close(), 60);
  }, 40);
});
ws.on("error", (e) => { console.error(e.message); process.exit(1); });
```

Expected: one `config { width: <px>, height: <px>, orientation: 'portrait' }` line, then exit 0. Verify delivery with `curl -fsS -H "Authorization: Bearer $SERVE_SIM_AUTH_TOKEN" "$SERVE_SIM_URL/api/event-log?device=$UDID&limit=5"`: the newest entry should be a tap at your x/y. Then take a second JPEG and compare it with the first.

Tags you'll actually use: `0x03` touch (`begin`/`move`/`end`), `0x04` button (`{button:"home"}`; hardware buttons also take `{page,usage,phase}`), `0x05` multi-touch, `0x06` key (`{type:"down"|"up", usage}`, USB HID page 0x07), `0x07` orientation (`{orientation:"portrait"|"portrait_upside_down"|"landscape_left"|"landscape_right"}`), `0x08` CoreAnimation debug, `0x09` memory warning (empty body), `0x0a` digital crown, `0x0b` scroll, `0x0c` software keyboard, `0x0d` preferred screen size, `0x0e` Duo pose/hinge.

## The maintainer loop (changing serve-sim itself)

When you're editing serve-sim and testing on the Mac, the loop is build-from-source, not Expo Go tab-switching:

1. Edit the TypeScript/Swift under `packages/serve-sim/`.
2. Build: `bun run packages/serve-sim/build.ts` (rebuilds the bundle, the compiled CLI, the native `.node` addon, and the camera/AX helpers; see [AGENTS.md](../../AGENTS.md)).
3. Restart the server from `dist/` so the new native addon loads (the addon is loaded once per process):
   `node packages/serve-sim/dist/serve-sim.js -k "$UDID" -q` then start it again as above.
4. Reproduce the behavior and run the relevant tests (`bun test packages/serve-sim/src/__tests__/<file>`).

Run the rebuilt local CLI (`node packages/serve-sim/dist/serve-sim.js ...`), not `npx serve-sim`, while validating local changes.

## Failure modes

| Symptom | Cause | Fix | Who |
|---|---|---|---|
| 401/403 on every remote call | No/wrong token | Set `SERVE_SIM_AUTH_TOKEN` (or `--auth-token`) to the server's token | Agent |
| 403 only from the tunnel, fine on loopback | Server started without `--auth-token` | Restart serve-sim with `--auth-token` | Mac |
| `--detach` exits: `already running for <udid> but was started with a different --auth-token` (or `with/without an --auth-token`) | An older server for this UDID has another token | `serve-sim -k "$UDID"`, then rerun the `--detach` step | Mac |
| `--detach` exits: `already running for <udid> but was started with --allow-exec, but it was not given now` | An older server for this UDID has the host shell on | `serve-sim -k "$UDID"`, then rerun the `--detach` step (without `--allow-exec`) | Mac |
| 403 `exec disabled; start with --allow-exec` (or, with it on, `exec is only available to loopback clients`) | Something called `/exec`; the host shell is off by default and never reachable through a tunnel | Remote agents can't use exec. Do host-side work in a Mac shell, and don't enable `--allow-exec` on a tunneled port | Mac |
| Preview UI tools (screenshot, camera, permissions, drops) fail over the tunnel with `host actions are only available to loopback clients` | Those tools are host actions, served only to a loopback same-origin page | Expected for a remote browser. Use the stream/HID/CLI routes, or run the action in a Mac shell | Agent |
| No frames after the Mac idles | Mac slept | Keep `caffeinate -dims`; reopen the stream after wake | Mac |
| `config` width/height stay 0 | Helper not ready yet | Wait and re-poll `/config`; restart serve-sim if it persists | Mac |
| Port already in use | Another preview on that port | Use the port from the `--detach` JSON; never take `:3200` | Mac |
| ngrok `ERR_NGROK_3200` | Stale ngrok URL | Restart ngrok; refresh `URL` | Mac |
| ngrok browser interstitial | Free-plan warning page | Send `ngrok-skip-browser-warning: 1` | Agent |
| Taps logged but UI unchanged | Device Hub input not attached | `serve-sim repair-input -d "$UDID"`, then restart serve-sim | Mac |
| **TCC / permission dialog on the simulator (human only)** | First camera/photos/etc. access | **A person must click it on the Mac** (or script an AX lookup + tap on the Mac). A remote agent cannot dismiss a TCC prompt. | **Human on the Mac** |
| **Xcode "install additional components" prompt (human only)** | First run of a new Xcode/runtime | **A person must complete it on the Mac.** | **Human on the Mac** |
| `/helper/<udid>/ax` returns 503 `{"error":"ax_unavailable","message":...}` (`/foreground`: `foreground_unavailable`) | The native AX probe failed. The `message` carries the cause, e.g. `No frontmost application returned for simulator` (Swift `AccessibilityError.noFrontmostApplication`, which is never the `error` code) or `Timed out waiting for accessibility response` | Launch an app first and retry; prove the change with a JPEG delta | Agent |

Steps marked **human only** need someone physically (or via GUI) on the Mac; they can't be done over the tunnel.

## Teardown

```bash
# Mac
node packages/serve-sim/dist/serve-sim.js -k "$UDID" -q
kill "$CAFFEINE_PID"            # stop caffeinate
# stop the ngrok / Tailscale serve / SSH forward you started
# retire the bot device when you're done with it entirely:
# xcrun simctl shutdown "$UDID" && xcrun simctl delete "$UDID"
```

Leave any other person's previews (and the default `:3200`) alone.
