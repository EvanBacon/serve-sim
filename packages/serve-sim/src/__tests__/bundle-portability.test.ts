import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// The published bundles must locate sibling artifacts (dist/simax,
// dist/simcam) relative to wherever npm installed them. Bun's bundler
// replaces a bare CommonJS `__dirname` with the *build machine's* source
// directory as a string constant, which resolves fine on the machine that
// built the package (masking the bug in local testing) and on nobody
// else's — `npx serve-sim` then fails with "sim-ax-settings binary not
// found". Modules needing __dirname must shadow it with
// `dirnameOf(import.meta.url)` (see src/runtime.ts); this suite catches
// any bundle that picked up the compile-time constant instead.

const PKG_DIR = join(import.meta.dir, "../..");
const SRC_DIR = join(PKG_DIR, "src");

const BUNDLES = ["dist/serve-sim.js", "dist/middleware.js"] as const;

// CI builds dist before running this directory; locally, run
// `bun run build.ts` first or the suite skips.
const describeIfBuilt = BUNDLES.every((b) => existsSync(join(PKG_DIR, b)))
  ? describe
  : describe.skip;

describeIfBuilt("bundle portability", () => {
  test.each([...BUNDLES])("%s has no build-machine path baked in", (bundle) => {
    const js = readFileSync(join(PKG_DIR, bundle), "utf-8");
    expect(js).not.toContain(SRC_DIR);
  });
});
