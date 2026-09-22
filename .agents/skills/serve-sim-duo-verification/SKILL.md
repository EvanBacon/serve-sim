---
name: serve-sim-duo-verification
description: Verify serve-sim Duo folding, guest orientation, and model rotation against a local iOS Simulator. Use after changing Duo pose, orientation, or display-selection behavior, or when investigating regressions in those features.
---

# Duo verification

Run commands from the repository root. Read the relevant checks in
[expected behavior](references/expected-behavior.md)
before choosing a test. Historical results live in
[verification](references/verification.md).
Keep reusable agent verification helpers in this skill's `scripts/` directory.

## Local setup

Use a booted iPhone Duo and the rebuilt local server. After native changes,
rebuild and restart the server so it loads the new addon:

```sh
bun run packages/serve-sim/build.ts
node packages/serve-sim/dist/serve-sim.js --port 3399
```

Use the actual server port and Duo UDID in subsequent commands. An existing
local server can be reused when its native build is current.

## Rotation matrix

Bring Safari to the foreground on the Duo before running:

```sh
xcrun simctl openurl <udid> https://example.com
bun .agents/skills/serve-sim-duo-verification/scripts/verify-duo-rotation.ts <udid> 3399
```

The script changes hinge angles to 0°, 130°, and 180° and cycles all four
orientations. It checks physical orientation using `devicectl`, active-panel UI
orientation using `simctl`, and model/configuration orientation over the server.
It restores the original hinge angle and model orientation in `finally`.
Safari remains foreground; this check does not restore the prior app.

Safari's cover UI excludes upside-down portrait; its inner UI supports all four
orientations. Settings can lock the cover to portrait, so it is unsuitable for
this matrix. Protocol landscape names are opposite CoreDevice physical names;
the inner panel also has a rotated natural axis. Preserve these distinctions
when diagnosing failures. Stop on a failed assertion and inspect the reported
physical, UI, and model orientations before retrying.

## Fold and panel selection

```sh
node packages/serve-sim/dist/serve-sim.js pose open -d <udid>
node packages/serve-sim/dist/serve-sim.js pose book -d <udid>
xcrun devicectl device motion hinge-angle --device <udid> --timeout 5
xcrun simctl io <udid> enumerate
```

Compare the preview's selected display with the latest SpringBoard
`DisplayContentMode` event containing `.cover:pri` or `.inner:pri`. Repeat after
`pose closed` to check the opposite direction. Follow guest panel readback;
do not infer primary-panel selection solely from hinge angle.

If Device Hub shadows input, consult the explicit `repair-input` procedure in
the package README. Repair can restart SpringBoard; do not run it as routine
verification setup. Numeric rotation checks do not establish visual smoothness,
color fidelity, or control alignment; check those in the in-app Codex browser
when available and report any unverified behavior.
