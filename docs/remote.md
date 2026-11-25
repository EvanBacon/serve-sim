# Remote simulator (`--tunnel` + `connect`)

Drive a simulator on your Mac from another machine: a Linux box, a CI runner, or a cloud coding agent. The Mac runs the simulator and a serve-sim preview behind a tunnel; the other machine runs ordinary `serve-sim` commands against it. Nothing on the client side needs macOS, Xcode or `simctl`.

To install a real build on a physical iPhone over the same kind of tunnel (OTA, works on cellular), see [Install on your iPhone from anywhere](install.md) (`serve-sim install <app.ipa>`).

## On the Mac

```sh
brew install cloudflared   # once; quick tunnels need no Cloudflare account
serve-sim --tunnel         # or: serve-sim --tunnel "iPhone 16 Pro" -p 3412
```

serve-sim starts the preview on `127.0.0.1`, generates a random auth token, opens a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) to it, and prints:

```
  - Local:   http://localhost:3200
  - Public:  https://lucky-otter-river-blue.trycloudflare.com
  - Viewer:  https://lucky-otter-river-blue.trycloudflare.com/#token=<token>
  - Token:   <token>

  On the agent machine (Linux works too):

    export SERVE_SIM_AUTH_TOKEN=<token>
    serve-sim connect https://lucky-otter-river-blue.trycloudflare.com
    serve-sim tap 0.5 0.5
```

It runs in the foreground. Ctrl+C stops the preview and the tunnel.

- **Pin the token**: `serve-sim --tunnel --auth-token <token>` (or `SERVE_SIM_AUTH_TOKEN`). Without it, every run gets a fresh token.
- **Reuse a tunnel you already run** (named cloudflared tunnel, ngrok, Tailscale Serve/Funnel, a reverse proxy) pointed at the preview port:

  ```sh
  serve-sim --tunnel -p 3412 --public-origin https://sim.example.com
  ```

  serve-sim doesn't start cloudflared; it only uses that origin in the printed URLs.

## On the agent machine

Install serve-sim (`npm i -g serve-sim` or `npx serve-sim …`; Node 20+), then:

```sh
export SERVE_SIM_AUTH_TOKEN=<token>
serve-sim connect https://lucky-otter-river-blue.trycloudflare.com

serve-sim tap 0.5 0.5
serve-sim type "hello"
serve-sim button home
serve-sim ax --refs && serve-sim tap @e3
serve-sim screenshot shot.png          # written on this machine (.png → PNG, else JPEG; - for stdout)
serve-sim open https://example.com     # simctl openurl on the Mac; deep links work too (myapp://…)

serve-sim disconnect
```

`connect` checks the URL with the token and saves only the URL to `~/.config/serve-sim/remote.json` (or `$XDG_CONFIG_HOME/serve-sim/remote.json`, mode 0600). The token always comes from `SERVE_SIM_AUTH_TOKEN` or `--auth-token`. `serve-sim connect` with no URL shows the saved one.

Commands pick their target in this order: `--url`, then `SERVE_SIM_URL`, then the `connect` profile, then the local server. So a one-off `--url https://…` still works without `connect`. When the Mac serves several simulators, pass the UDID with `-d`.

## Viewer

Open the printed `Viewer` URL in a browser, such as the desktop of a cloud agent, to watch and click the live simulator. The token rides in the `#token=` fragment, which browsers never send. The page trades it for an HttpOnly cookie and removes it from the address bar.

## Security

- The token is a bearer secret. Anyone who has it can control the simulator (tap, type, open URLs, read the screen). Share it like a password.
- A quick tunnel is a public HTTPS URL, so the token is the only gate. Every route, stream and WebSocket checks it. Requests without it get `401`.
- `--tunnel` keeps the preview bound to `127.0.0.1`. It is reachable only through the tunnel, not your LAN.
- The token is never written to the `connect` profile or any other file. Share links put it in the fragment (`#token=`). `?token=` is never accepted, because query strings end up in proxy and server logs.
- Don't add `--allow-exec` to a tunneled server. The host shell stays loopback-only, but `.ipa` installs (host code execution) get enabled for the preview page.
- Stop the tunnel (Ctrl+C) when you're done. A restart without `--auth-token` revokes the old token.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `cloudflared is not installed` | `brew install cloudflared`, or run your own tunnel and pass `--public-origin`. |
| `HTTP 401` / `refused the token` | `SERVE_SIM_AUTH_TOKEN` is missing or stale. Re-export the token the Mac printed. A restarted `--tunnel` prints a new one. |
| `Failed to reach serve-sim` right after starting | A new quick tunnel can take a few seconds to resolve in DNS. Retry. |
| Worked before, now unreachable | Quick tunnel URLs change on every restart. `serve-sim connect <new-url>`. |
| Commands go to the wrong place | Check `serve-sim connect` (no args), `SERVE_SIM_URL` and `--url`. `serve-sim disconnect` returns to the local simulator. |
| `HTTP 404` from `screenshot` / `open` | The Mac runs an older serve-sim. Use the same version on both sides. |
| `cloudflared` fails with a `config.yml` | A `~/.cloudflared/config.yml` for a named tunnel can interfere with quick tunnels. Move it aside or use `--public-origin` with your named tunnel. |
| Token showing up in logs | Never put it in a URL query string. Use the header (CLI) or the `#token=` link (browser). |
