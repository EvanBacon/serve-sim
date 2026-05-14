# Workflows reference

Recipes for common end-to-end agent tasks. These compose the primitives documented in the other reference files.

## Contents

- Workflow 1: Tap on a UI element by accessibility label
- Workflow 2: Deep-link into an app and verify the screen
- Workflow 3: Test a camera capture flow
- Workflow 4: Find blended layers in a screen
- Workflow 5: Reset and re-test (clean slate)
- Workflow 6: Drive a multi-step gesture reliably
- Workflow 7: Show the simulator stream in the host's preview

## Workflow 1: Tap on a UI element by accessibility label

Pixel-hunting is fragile across device sizes. Prefer driving taps from the accessibility tree.

```sh
# 1. Ensure serve-sim is running and discover the stream port
URL=$(npx serve-sim --list -q | jq -r '.[0].streamUrl')
PORT=$(echo "$URL" | sed -E 's|.*://[^:]+:([0-9]+).*|\1|')

# 2. Fetch the accessibility tree
AX=$(curl -s "http://localhost:${PORT}/ax")

# 3. Find the element by label (use jq with a query that matches your tree shape)
TARGET=$(echo "$AX" | jq '.[] | select(.label == "Submit")')

# Guard: if no element matched, fail loudly. Never guess coordinates when the
# AX tree didn't contain the target — tapping a random spot is almost always
# worse than reporting the failure.
if [ -z "$TARGET" ] || [ "$TARGET" = "null" ]; then
  echo "ERROR: no element with label 'Submit' found in accessibility tree" >&2
  exit 2
fi

CX=$(echo "$TARGET" | jq '.frame.x + .frame.width / 2')
CY=$(echo "$TARGET" | jq '.frame.y + .frame.height / 2')

# 4. Normalize coordinates against the display
CONFIG=$(curl -s "http://localhost:${PORT}/config")
W=$(echo "$CONFIG" | jq '.width')
H=$(echo "$CONFIG" | jq '.height')
NX=$(echo "scale=4; $CX / $W" | bc)
NY=$(echo "scale=4; $CY / $H" | bc)

# 5. Tap
npx serve-sim tap "$NX" "$NY"
```

The exact `jq` query depends on your tree shape — inspect with `curl /ax | jq` and adapt.

## Workflow 2: Deep-link into an app and verify the screen

```sh
# 1. Open the URL — uses Apple's simctl, not serve-sim
xcrun simctl openurl booted "myapp://products/42"

# 2. Wait briefly for the app to handle the deep link
sleep 1

# 3. Resolve the stream endpoint — do not hardcode :3100, it may differ
PORT=$(npx serve-sim --list -q | jq -r '.[0].streamUrl' | sed -E 's|.*://[^:]+:([0-9]+).*|\1|')

# 4. Verify the frontmost app is yours
curl -s "http://localhost:${PORT}/foreground" | jq
# Expect: {"bundleId":"com.acme.myapp","pid":12345}

# 5. Verify the screen by reading the accessibility tree
curl -s "http://localhost:${PORT}/ax" | jq '.[] | select(.label | test("Product #42"))'
```

## Workflow 3: Test a camera capture flow

```sh
# 1. Clean state
npx serve-sim camera --stop-webcam
xcrun simctl terminate booted com.acme.MyApp

# 2. Inject a known test image, force no-mirror so any text reads right
npx serve-sim camera com.acme.MyApp --file ~/test-assets/reference.png --mirror off

# 3. Navigate to the capture screen
xcrun simctl openurl booted "myapp://camera/capture"
sleep 1

# 4. Tap the shutter (50% horizontal, 90% vertical)
npx serve-sim tap 0.5 0.9
sleep 1

# 5. Inspect the saved capture in the app's sandbox
APP_DATA=$(xcrun simctl get_app_container booted com.acme.MyApp data)
ls -la "$APP_DATA/Documents/captures/"

# 6. Tear down
npx serve-sim camera --stop-webcam
```

## Workflow 4: Find blended layers in a screen

```sh
# 1. Turn on blended-layers overlay
npx serve-sim ca-debug blended on

# 2. Navigate to the screen of interest (via openurl, taps, etc.)
xcrun simctl openurl booted "myapp://settings"

# 3. Resolve the stream endpoint — do not hardcode :3100, it may differ
PORT=$(npx serve-sim --list -q | jq -r '.[0].streamUrl' | sed -E 's|.*://[^:]+:([0-9]+).*|\1|')

# 4. Grab a screenshot from the MJPEG stream
curl -s "http://localhost:${PORT}/stream.mjpeg?raw=1" \
  --max-time 1 -o /tmp/blended.jpg

# 5. Inspect — red regions are blended (expensive); green is opaque (good)
open /tmp/blended.jpg

# 6. Turn off
npx serve-sim ca-debug blended off
```

The single-shot `curl --max-time 1` grabs the first JPEG frame from the MJPEG stream. For a clean frame grab, prefer the preview UI's screenshot button or read multiple frames and pick a stable one.

## Workflow 5: Reset and re-test (clean slate)

When tests pollute the simulator state, fastest reset:

```sh
# Kill all serve-sim helpers (frees ports, drops streams)
npx serve-sim --kill

# Terminate your app
xcrun simctl terminate booted com.acme.MyApp

# (Optional) erase the simulator entirely — destroys app data
# xcrun simctl shutdown booted
# xcrun simctl erase booted
# xcrun simctl boot <UDID>

# Restart serve-sim
npx serve-sim --detach -q
```

The full erase is destructive — only do it when the user explicitly asks.

## Workflow 6: Drive a multi-step gesture reliably

For a complex gesture (long drag, multi-finger choreography), the CLI's `gesture` subcommand is unreliable because each call opens a fresh WebSocket. The reliable path is one persistent WebSocket connection.

In a Node agent:

```js
import WebSocket from "ws";
import { encodeSingleTouch, encodeMultiTouch } from "serve-sim-client/touch-codec";

// 3100 is the default stream port — discover the real one with
// `serve-sim --list -q` (.streamUrl) when it may differ.
const ws = new WebSocket("ws://localhost:3100/ws");
await new Promise((r) => ws.once("open", r));

let seq = 0;
function send(data) {
  const buf = data.x1 !== undefined
    ? encodeMultiTouch(data, seq++)
    : encodeSingleTouch(data, seq++);
  ws.send(buf);
}

// Long vertical drag
send({ type: "begin", x: 0.5, y: 0.2 });
for (let i = 1; i <= 30; i++) {
  send({ type: "move", x: 0.5, y: 0.2 + (0.6 * i) / 30 });
  await new Promise((r) => setTimeout(r, 16));
}
send({ type: "end", x: 0.5, y: 0.8 });

ws.close();
```

If you do not want a Node dependency, you can build the same frames in any language — the binary format is documented in [endpoints.md](endpoints.md).

## Workflow 7: Show the simulator stream in the host's preview

The user has a simulator running with their app already in the foreground. They want to see it streamed into the same tool they're chatting with the agent in (Claude Code, Cursor, Codex CLI, or any other host) so they don't have to leave the conversation to open a browser.

The trick is that **the skill cannot invoke the host's preview tool directly** — each host (Claude Code, Cursor, Codex, …) has its own URL-opening mechanism with a different tool name and signature. The agent must inspect its own toolset and route accordingly.

```sh
# 1. Start serve-sim in detached mode and capture the JSON
STREAM_JSON=$(npx serve-sim --detach -q)
URL=$(echo "$STREAM_JSON" | jq -r '.url')
STREAM_URL=$(echo "$STREAM_JSON" | jq -r '.streamUrl')

# 2. Surface the URL plainly to the user so they always have a manual fallback
echo "Simulator stream URL: $URL"
echo "Raw MJPEG endpoint:   $STREAM_URL"
```

3. Hand off to the host's preview tool, **only if one is available in the current toolset**:

   - **Claude Code**: if `preview_start` (or `mcp__Claude_Preview__preview_start`) appears in the toolset, call it with `{ url: "$URL" }`. The integrated preview pane will render the simulator stream live.
   - **Cursor**: there is no agent-callable preview tool in Cursor today. Print the URL prominently and tell the user "open this URL in Cursor's built-in browser pane (Cmd+P → 'Open URL')".
   - **Codex CLI**: print the URL and tell the user to open it in their browser. Codex does not expose a preview tool to the agent.
   - **Other hosts / MCP setups**: scan available tools for names containing `preview`, `browser`, `open_url`, `open`, etc. If you find a match whose signature accepts a URL, try it; if it fails, fall back to printing.

4. **Never invent a tool name.** If your toolset does not include a URL-opening tool, do not pretend to call one. Tell the user explicitly: "I can't open URLs in your host's preview directly. Open $URL in your browser to see the stream."

5. The stream persists until `npx serve-sim --kill`. Multiple clients (the host preview + the user's browser + a tunnel) can connect to the same URL at once.

### Why this is split between skill and host

The skill knows how to make a URL exist (`serve-sim --detach`). The host knows how to render a URL in its preview. The agent is the glue — it should detect which side of that glue is available in the current session and act accordingly. There is no single "open in preview" command because each host has reinvented it.

### Quick decision tree

- Did `--detach -q` return a valid `url`? If not, stop and report the failure.
- Is there a `preview_start`-like tool in your current toolset? Call it.
- No such tool? Print the URL plainly and instruct the user how to open it.
- Did the preview tool reject the URL or fail? Fall back to printing.
