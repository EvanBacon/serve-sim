# Device Placeholder Assets

Use this workflow when updating the Device Hub-style placeholder images after installing a new Xcode or macOS seed.

## Source of Truth

- Simulator model metadata: `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/*.simdevicetype/Contents/Resources/profile.plist`
- Device preview icons: `/System/Library/CoreServices/CoreTypes.bundle/Contents/Library/MobileDevices.bundle/Contents/Resources/`
- Icon mapping metadata: `MobileDevices-Info.plist` in the same resources directory

`serve-sim` should prefer CoreTypes icon metadata over display-name regexes. Match simulator profiles by `modelIdentifier` or `productClass + "AP"` against `UTTypeTagSpecification["com.apple.device-model-code"]`. Use the first matching `UTTypeIconFile`; Apple’s plist order reflects the default preview art.

## Audit Command

Run:

```sh
node .codex/skills/serve-sim-placeholder-assets/scripts/audit-placeholder-assets.mjs --out tmp/device-placeholder-assets
```

This prints every iPhone, iPad, Apple Watch, and Apple Vision Pro simulator profile with:

- `exact`: CoreTypes has a model-code match.
- `fallback`: `serve-sim` has an explicit alias because CoreTypes is missing that exact new model.
- `missing`: no CoreTypes match and no alias; add support or let the UI fall back to DeviceKit/SVG.

The script also writes cropped preview PNGs plus `audit.json` to the output directory. Inspect the PNGs for any new family before changing code.

Use `--json` for machine-readable output, and `--no-render` when only checking mapping coverage.

## Code Update Checklist

1. If a new simulator model is `missing`, check `MobileDevices-Info.plist` for a suitable icon entry.
2. Prefer exact model-code support in `devicekit-chrome.ts`; only add `FALLBACK_PLACEHOLDER_ASSETS` aliases when Apple has not shipped exact metadata yet.
3. Keep fallback aliases small and explain why they exist.
4. Do not hard-code crop boxes. The server and audit script compute alpha bounds from the converted PNG.
5. Verify with:

```sh
bun test packages/serve-sim/src/__tests__/device-placeholder.test.tsx packages/serve-sim/src/__tests__/devicekit-chrome.test.ts
bun run typecheck
bun run packages/serve-sim/build.ts
```

6. Start the server and inspect representative iPhone, iPad, Watch, and Vision placeholders in the browser.
