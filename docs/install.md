# Install on your iPhone from anywhere (`serve-sim install`)

`serve-sim install` puts a real, signed iOS build on your physical iPhone over the internet. It uses Apple's over-the-air (OTA) `itms-services` install, the same mechanism as Ad Hoc distribution sites, served over HTTPS through a free Cloudflare quick tunnel. It works on cellular. There's no cable, no debugger, no Xcode on the phone side, and no simulator involved.

```sh
brew install cloudflared        # once; no Cloudflare account needed
serve-sim install MyApp.ipa
```

It prints the app, its signing summary, a QR code and the links:

```
  OTA Test 1.0 (7)
  Bundle:   com.example.app
  Signing:  Development profile, team Example (ABCDE12345), expires 2026-11-29
  Devices:  1 provisioned: 00008101-001A2B3C4D5E6F70
            Your iPhone must be in this list; find its UDID with `xcrun devicectl list devices`.

  Scan with the iPhone Camera, or open the page in Safari:

  ▄▄▄▄▄▄▄ ...

  - Page:     https://lucky-otter-river-blue.trycloudflare.com/install/<random>/
  - Direct:   itms-services://?action=download-manifest&url=https%3A%2F%2F...
  - Expires:  11/24/2026, 5:30:39 PM (in 30m)

  Anyone with the link can download the .ipa while it's live. Ctrl+C to stop.
```

Scan the QR with the iPhone Camera, tap **Install**, confirm, and the app appears on the home screen.

## One-time requirement: a build iOS will install OTA

iOS only installs signed builds whose provisioning profile allows the device:

| Profile | Installs OTA? |
| --- | --- |
| **Development** (`get-task-allow`, device list) | Yes, on listed devices. Needs Developer Mode on the phone. |
| **Ad Hoc** / Release Testing (device list) | Yes, on listed devices. |
| **Enterprise** / In-House (`ProvisionsAllDevices`) | Yes, any device. |
| App Store / TestFlight | No. `serve-sim install` warns. |
| Unsigned | No. `serve-sim install` warns. |

Your iPhone's UDID must be in the profile. Find it with `xcrun devicectl list devices` (or Finder / Xcode's Devices window), register it in the Apple Developer portal, and regenerate the profile. `serve-sim install MyApp.ipa --udid <udid>` tells you whether a device is included.

## Exporting an .ipa

- **Xcode**: Product > Archive, then Organizer > Distribute App > **Release Testing** (Ad Hoc) or **Debugging** (Development) > Export.
- **Command line**:

  ```sh
  xcodebuild -scheme MyApp -archivePath build/MyApp.xcarchive archive
  xcodebuild -exportArchive -archivePath build/MyApp.xcarchive \
    -exportOptionsPlist ExportOptions.plist -exportPath build/
  ```

  with an `ExportOptions.plist` whose `method` is `release-testing` or `debugging` (older Xcode: `ad-hoc` or `development`):

  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>method</key><string>release-testing</string>
    <key>teamID</key><string>ABCDE12345</string>
  </dict></plist>
  ```

On macOS you can also pass a signed `.app` or an `.xcarchive` directly; serve-sim zips it as `Payload/<Name>.app` with `ditto`.

## Commands

```sh
serve-sim install MyApp.ipa                     # quick tunnel, link lives 30 minutes
serve-sim install MyApp.ipa --once --ttl 10m    # stop after one complete download, or 10 minutes
serve-sim install MyApp.ipa --udid 00008101-001A2B3C4D5E6F70
serve-sim install MyApp.ipa --json              # one JSON object: urls, expiresAt, app, profile, warnings
serve-sim install MyApp.ipa -p 3412 --public-origin https://ota.example.com   # your own https tunnel/proxy to that port
```

| Option | Meaning |
| --- | --- |
| `--ttl <duration>` | How long the link works: `30m` (default), `2h`, `90s`; max `24h`. |
| `--once` | Revoke the link and exit once the .ipa has been downloaded completely. |
| `-p, --port <n>` | Local port (default: first free from 3412). The server binds to `127.0.0.1` only. |
| `--public-origin <url>` | Skip cloudflared and use an https origin you already forward to that port (named tunnel, ngrok, Tailscale Funnel). Must be https; iOS refuses OTA over http. |
| `--udid <udid>` | Check whether a device is in the profile. |
| `--json` | Machine-readable output (no QR). Progress goes to stderr. |

It runs in the foreground until Ctrl+C, the TTL, or `--once`, then stops cloudflared and the server.

## Security model

- iOS's installer fetches the manifest and the .ipa itself, without cookies or headers, so the link is the credential: `/install/<cap>/`, where `<cap>` is 32 random bytes (base64url) minted for this run. Every other path, a wrong cap, and everything after expiry or `--once` return a plain `404`.
- **Anyone with the link can download the .ipa while it's live.** Share it like a password, keep the TTL short, and use `--once` for a single install.
- This server exposes none of the serve-sim simulator API and never uses `SERVE_SIM_AUTH_TOKEN`. Query strings (`?token=`) are ignored and grant nothing.
- Responses send `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `X-Robots-Tag: noindex`. The install page has a strict CSP, no scripts and no external resources.
- The server listens on `127.0.0.1` only; it's reachable only through the tunnel.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **"Unable to Install …"** | The phone's UDID isn't in the profile (check with `--udid`), the profile expired, or (development builds) Developer Mode is off: Settings > Privacy & Security > Developer Mode. |
| **"Integrity could not be verified"** | The .ipa's signature doesn't match the profile/entitlements, or the app was modified after signing. Re-export from Xcode. |
| Nothing happens after tapping Install | The build is App Store / TestFlight signed or unsigned (serve-sim prints a warning), or the bundle id doesn't match the profile. |
| Page doesn't load right after starting | A new quick tunnel takes a few seconds to resolve in DNS. Retry. |
| `cloudflared is not installed` | `brew install cloudflared`, or pass `--public-origin` with your own https tunnel. |
| `404` | The link expired, `--once` already used it, or serve-sim was restarted (every run mints a new link). |
| `cloudflared` fails with a `config.yml` | A `~/.cloudflared/config.yml` for a named tunnel can interfere with quick tunnels. Move it aside or use `--public-origin`. |
