# App permissions reference

`npx serve-sim permissions` manages an installed app's privacy permissions on
the booted simulator. It is modelled on AppleSimulatorUtils but writes the
underlying state stores directly, because `xcrun simctl privacy` is timing-
fragile and cannot touch push notifications at all.

## CLI surface

```sh
npx serve-sim permissions grant  <permission> <bundle-id> [--value <v>] [-d <udid|name>]
npx serve-sim permissions revoke <permission> <bundle-id> [-d <udid|name>]
npx serve-sim permissions reset  <permission|all> <bundle-id> [-d <udid|name>]
npx serve-sim permissions list   [bundle-id] [-d <udid|name>]
```

- `grant` — allow the permission.
- `revoke` (alias: `deny`) — deny the permission.
- `reset` — clear it so the app is prompted again next time. `reset all` clears
  every permission for the bundle id.
- `list` — print current state as JSON: a `tcc` map (keyed by the same
  permission names `grant`/`revoke`/`reset` accept), plus `location` and
  `notifications`. Pass `-q` for single-line JSON.

`<bundle-id>` is required for every verb except `list`. The app must be
installed; `location` in particular silently no-ops on an uninstalled bundle.

## Supported permissions

| Permission | `--value` options | Notes |
|---|---|---|
| `notifications` | `critical` | Push notifications. The headline feature — `simctl privacy` cannot do this. |
| `location` | `always`, `inuse` (default), `never` | `revoke` ⇒ never. |
| `camera` | — | |
| `microphone` | — | |
| `photos` | `limited` | `limited` ⇒ the iOS 14+ limited-library mode. |
| `photos-add` | — | Add-to-photos only. |
| `contacts` | — | |
| `calendar` | — | |
| `reminders` | — | |
| `motion` | — | |
| `media-library` | — | |
| `siri` | — | |
| `speech` | — | |
| `faceid` | — | |
| `user-tracking` | — | |
| `homekit` | — | |

Aliases accepted for parity with AppleSimulatorUtils / agent-device:
`push` → `notifications`, `photo-library`/`photo` → `photos`, `mic` →
`microphone`, `location-always` → `location --value always`,
`location-inuse` → `location --value inuse`.

A trailing positional is also accepted as the value, e.g.
`permissions grant photos com.foo.bar limited`.

## How it works (and why)

- **TCC permissions** (camera, photos, contacts, …) are written straight into
  the simulator's `TCC.db` with `sqlite3`. `simctl privacy` works for these too
  but races simulator boot; the direct write is deterministic.
- **Notifications** are written into the BulletinBoard `VersionedSectionInfo.plist`
  (the same mechanism Settings → Notifications reads). `simctl privacy` has no
  `notifications` service at all.
- **Location** is delegated to `xcrun simctl privacy`, because iOS keys
  `locationd`'s `clients.plist` entries as `i<bundleId>:` — a format that
  `plutil` and `PlistBuddy` cannot address, but `simctl privacy` handles
  correctly.

This command manages the *permission* only — it does not deliver a
notification. To push a test notification, use `xcrun simctl push`.

## Examples

```sh
# Grant push notifications (including critical alerts)
npx serve-sim permissions grant notifications com.example.app
npx serve-sim permissions grant notifications com.example.app --value critical

# Location, always-on
npx serve-sim permissions grant location com.example.app --value always

# Limited photo library
npx serve-sim permissions grant photos com.example.app --value limited

# Deny the camera, then inspect everything
npx serve-sim permissions revoke camera com.example.app
npx serve-sim permissions list com.example.app -q

# Wipe every permission so the next launch re-prompts
npx serve-sim permissions reset all com.example.app
```

## Notes

- Changes are written to disk immediately. An app that's already running may
  need to be relaunched to observe the new state.
- Use a real installed bundle id. Find one with
  `xcrun simctl listapps booted`.
