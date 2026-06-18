---
name: serve-sim-placeholder-assets
description: Audit and update serve-sim's Device Hub-style simulator placeholder assets from local Xcode/CoreTypes resources. Use after installing a new Xcode or macOS seed, or when iPhone, iPad, Watch, or Vision placeholder previews look wrong.
---

# serve-sim Placeholder Assets

Use this project-scoped skill when updating the not-running device preview images in this repo.

## Workflow

1. Read [references/device-placeholder-assets.md](references/device-placeholder-assets.md).
2. Run the audit script from the repo root:

   ```sh
   node .codex/skills/serve-sim-placeholder-assets/scripts/audit-placeholder-assets.mjs --out tmp/device-placeholder-assets
   ```

3. Keep the public `skills/serve-sim` skill focused on end-user CLI usage; do not add this internal asset-maintenance workflow there.
4. Update app code/tests only after reviewing the audit output for exact, fallback, or missing mappings.
