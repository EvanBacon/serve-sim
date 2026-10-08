# Driving a Mac simulator from a Linux agent

This is how I let an agent that runs on Linux (a cloud agent, a CI job, a bot in a container) verify iOS changes. It drives a simulator on a Mac running `serve-sim`. The agent never needs macOS: it speaks HTTP and one WebSocket to the Mac over an authenticated tunnel, and reads JPEG frames back for evidence.

Read it top to bottom the first time. Fill in the values from [Variables](#variables) and the commands paste as-is.

> **Requires the `--auth-token` / `--url` support from the "Require auth for exec and remote access" change.** Older builds have no remote auth and must not be tunneled. See that PR for why.

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
- The serve-sim CLI (`npx serve-sim@<version-with---url>`, or a checkout: `bun install`, then `bun run packages/serve-sim/src/index.ts ...`). Or just the `ws` package for the [direct WebSocket recipe](#direct-websocket-recipe).

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
   `ssh -N -L "$PORT:127.0.0.1:$PORT" mac-user@mac-host`. Then `URL=http://127.0.0.1:$PORT`. The forwarded connection arrives on the Mac from loopback, so set the token anyway (the agent is a remote process over the forward); it's required.
2. **Tailscale (preferred for long-lived).** Put the Mac and the Linux host on your tailnet and reach the Mac's tailnet IP directly, or `tailscale serve`. Restrict with tailnet ACLs.
3. **ngrok with auth.** `ngrok http "$PORT"` gives an HTTPS URL. serve-sim's `--auth-token` is what actually protects it; keep the URL out of git and chat. Free ngrok injects a browser warning — send `ngrok-skip-browser-warning: 1` on every request. ngrok forwards from loopback with `X-Forwarded-For`, which serve-sim treats as remote, so the token is enforced.

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
node packages/serve-sim/dist/serve-sim.js --detach -p "$PORT" --auth-token "$TOKEN" "$UDID"
```

`--detach` prints one line of JSON and exits, leaving the helper running. **Read the port back from that JSON** rather than assuming it; serve-sim picks the next free port if `PORT` is taken:

```bash
PORT=$(node packages/serve-sim/dist/serve-sim.js --detach -p "$PORT" --auth-token "$TOKEN" "$UDID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["port"])')
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

The agent needs exactly two values: `URL` and `TOKEN` (plus `UDID`). Pass them as environment variables to the agent process, or write them to a file the agent reads. Never commit them. The agent uses them two ways:

- The CLI reads `SERVE_SIM_URL` and `SERVE_SIM_AUTH_TOKEN` (or the `--url` / `--auth-token` flags).
- The direct WebSocket recipe reads `URL`, `TOKEN`, `UDID` from its own env.

```bash
# On the Linux agent:
export SERVE_SIM_URL="$URL"
export SERVE_SIM_AUTH_TOKEN="$TOKEN"
export UDID="<same-udid>"
```

## Linux: attach and verify

```bash
# ngrok free also needs: -H 'ngrok-skip-browser-warning: 1'
curl -fsS -H "Authorization: Bearer $SERVE_SIM_AUTH_TOKEN" "$SERVE_SIM_URL/helper/$UDID/health"
curl -fsS -H "Authorization: Bearer $SERVE_SIM_AUTH_TOKEN" "$SERVE_SIM_URL/helper/$UDID/config"
# Wait until config width/height are non-zero before driving input.
```

## Linux: drive it with the CLI

With `SERVE_SIM_URL` and `SERVE_SIM_AUTH_TOKEN` set, the normal input commands target the Mac:

```bash
serve-sim tap 0.5 0.9 -d "$UDID"       # ack'd; exits non-zero if the tap is not delivered
serve-sim button home -d "$UDID"
serve-sim event-log -d "$UDID"         # read back what the device received
```

Grab a JPEG for evidence (first frame of the MJPEG stream):

```bash
curl -fsS -H "Authorization: Bearer $SERVE_SIM_AUTH_TOKEN" \
  "$SERVE_SIM_URL/helper/$UDID/stream.mjpeg?raw=1" --output - | \
  head -c 400000 > before.jpg
```

## Direct WebSocket recipe

When you don't want the CLI, drive input over one WebSocket. This matches what the server actually handles, verified against a running server:

- Connect to `<ws-base>/helper/<UDID>/ws` (`ws://` or `wss://`), where `<ws-base>` is `URL` with the scheme swapped to ws/wss.
- Each input is **one binary frame**: a 1-byte tag, then UTF-8 JSON.
- The tags the server handles are `0x03`-`0x0e` (see [the full list](../../skills/serve-sim/references/endpoints.md#websocket-message-types)). There is no 0x10/0x11 binary-struct format and no `serve-sim-client/touch-codec` package.
- The server pushes a config frame (first byte `0x82`) on connect and on change; ignore inbound frames you don't need, or read `0x82` for live width/height/orientation.
- A tap is `0x03` `begin` then `0x03` `end` on the same socket, ~40 ms apart. `x`/`y` are normalized `0..1`.

```js
// npm i ws   —   env: URL, TOKEN, UDID
import WebSocket from "ws";

const wsBase = process.env.URL.replace(/^http/, "ws");
const headers = {
  Authorization: `Bearer ${process.env.TOKEN}`,
  // ngrok free only:
  // "ngrok-skip-browser-warning": "1",
};

function frame(tag, payload) {
  const json = Buffer.from(JSON.stringify(payload));
  return Buffer.concat([Buffer.from([tag]), json]);
}

const ws = new WebSocket(`${wsBase}/helper/${process.env.UDID}/ws`, { headers });

ws.on("message", (data) => {
  const buf = Buffer.from(data);
  if (buf[0] === 0x82) {
    // server config: {width, height, orientation, ...}
    console.error("config", JSON.parse(buf.subarray(1).toString("utf8")));
  }
});

ws.on("open", () => {
  const x = 0.5, y = 0.9;
  ws.send(frame(0x03, { type: "begin", x, y }));         // touch down
  setTimeout(() => {
    ws.send(frame(0x03, { type: "end", x, y }));         // touch up  -> a tap
    setTimeout(() => ws.close(), 60);
  }, 40);
});
```

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
| No frames after the Mac idles | Mac slept | Keep `caffeinate -dims`; reopen the stream after wake | Mac |
| `config` width/height stay 0 | Helper not ready yet | Wait and re-poll `/config`; restart serve-sim if it persists | Mac |
| Port already in use | Another preview on that port | Use the port from the `--detach` JSON; never take `:3200` | Mac |
| ngrok `ERR_NGROK_3200` | Stale ngrok URL | Restart ngrok; refresh `URL` | Mac |
| ngrok browser interstitial | Free-plan warning page | Send `ngrok-skip-browser-warning: 1` | Agent |
| Taps logged but UI unchanged | Device Hub input not attached | `serve-sim repair-input -d "$UDID"`, then restart serve-sim | Mac |
| **TCC / permission dialog on the simulator (human only)** | First camera/photos/etc. access | **A person must click it on the Mac** (or script an AX lookup + tap on the Mac). A remote agent cannot dismiss a TCC prompt. | **Human on the Mac** |
| **Xcode "install additional components" prompt (human only)** | First run of a new Xcode/runtime | **A person must complete it on the Mac.** | **Human on the Mac** |
| AX returns 503 `noFrontmostApplication` | No app in foreground | Launch an app first; prove the change with a JPEG delta | Agent |

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
