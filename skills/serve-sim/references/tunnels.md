# Public Quick Tunnels

Use this workflow when the user wants to open and control serve-sim from a
different computer or mobile device without RDP, a VPN, or a LAN connection.

## Prerequisites

Quick Tunnel mode requires `cloudflared` on the macOS host in addition to the
normal serve-sim prerequisites:

```sh
scripts/check-prereqs.sh --tunnel
```

If it is missing, tell the user to install it and stop. Do not silently install
software:

```sh
brew install cloudflared
```

A Cloudflare account or login is not required for a Quick Tunnel.

## Start and hand off a detached tunnel

For an agent workflow, prefer detached JSON output:

```sh
TUNNEL_JSON=$(npx serve-sim --tunnel --detach -q)
PUBLIC_URL=$(echo "$TUNNEL_JSON" | jq -r '.publicUrl')

if [[ -z "$PUBLIC_URL" || "$PUBLIC_URL" == "null" ]]; then
  echo "serve-sim did not return a public tunnel URL" >&2
  exit 1
fi

echo "Simulator public URL: $PUBLIC_URL"
```

`--public` is an alias for `--tunnel`. The returned `publicUrl` is the
human-facing preview. Always give the user the complete URL, including the
`token` query parameter, so they can copy it into a remote PC or mobile
browser. Do not substitute the local URL or a raw stream URL.

The first browser request exchanges the query token for a secure, HTTP-only,
host-only cookie and redirects to a clean URL. Each new browser profile or
device must open the complete tokenized URL once.

## Security model

Treat the complete URL as a credential:

- Anyone with it can view and control the simulator.
- An authorized preview can use features that execute commands on the host.
- Do not paste it into logs, issues, PRs, or unrelated chat messages.
- Quick Tunnels do not add Cloudflare Access or an identity login. The random
  hostname plus serve-sim's access token are the protection.
- Quick Tunnels are for temporary development/testing. For a stable hostname,
  identity policy, or production guarantees, recommend a managed Cloudflare
  Tunnel with Cloudflare Access instead.

The preview origin remains bound to `127.0.0.1`; serve-sim does not open a LAN
listener in tunnel mode.

## Attached versus detached lifecycle

Attached mode:

```sh
npx serve-sim --tunnel
```

The terminal stays attached. `Ctrl+C` stops both serve-sim and its
`cloudflared` child.

Detached mode:

```sh
npx serve-sim --tunnel --detach -q
```

The preview owner and `cloudflared` continue in the background. Stop them with:

```sh
npx serve-sim --kill
```

Ending the preview owner through the normal process-termination paths
(`SIGINT`, `SIGTERM`, `SIGHUP`, or `--kill`) also ends its `cloudflared` child.
Do not use `kill -9`: `SIGKILL` prevents every application from running its
cleanup handlers.

When the user explicitly asks to keep the tunnel running, leave it running and
state how to stop it. Otherwise, follow the skill's normal cleanup rule and run
`npx serve-sim --kill` when the task is finished.

## Diagnostics

Tunnel state and diagnostics follow serve-sim's runtime-state convention:

```text
$TMPDIR/serve-sim/tunnel.json
$TMPDIR/serve-sim/tunnel.log
```

Both files are owner-only (`0600`). The log contains lifecycle events and raw
`cloudflared` output but not the private access token. Prefer the log when a
tunnel exits or never becomes ready; do not add polling, heartbeats, or a
second logging system.

If `cloudflared` is absent, serve-sim exits before booting or publishing the
preview and prints the install command. If a detached launch fails, surface the
reported error and the diagnostics path rather than guessing at a URL.
