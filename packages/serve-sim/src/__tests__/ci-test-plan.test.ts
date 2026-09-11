import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DARWIN_INTEGRATION_TEST_FILES,
  SIM_E2E_TEST_FILES,
  isDarwinSkipPath,
  isDarwinTestFile,
  needsDarwinE2E,
} from "../ci-test-plan";

const REPO = join(import.meta.dir, "../../../..");

function workflow(name: string): string {
  return readFileSync(join(REPO, ".github/workflows", name), "utf-8");
}

function actionYml(): string {
  return readFileSync(join(REPO, ".github/actions/build-serve-sim-for-ci/action.yml"), "utf-8");
}

describe("Darwin vs unit test plan", () => {
  test("every listed Darwin file exists", () => {
    for (const file of [...SIM_E2E_TEST_FILES, ...DARWIN_INTEGRATION_TEST_FILES]) {
      expect(existsSync(join(REPO, file))).toBe(true);
    }
  });

  test("listed files are classified as Darwin tests", () => {
    for (const file of SIM_E2E_TEST_FILES) expect(isDarwinTestFile(file)).toBe(true);
    expect(isDarwinTestFile(DARWIN_INTEGRATION_TEST_FILES[0]!)).toBe(true);
    expect(isDarwinTestFile("packages/serve-sim/src/__tests__/ports.test.ts")).toBe(false);
  });

  test("client/docs/unit-only diffs skip Darwin e2e; native/sim paths do not", () => {
    expect(needsDarwinE2E(["packages/serve-sim/src/client/client.tsx"])).toBe(false);
    expect(needsDarwinE2E(["packages/serve-sim/src/__tests__/ports.test.ts"])).toBe(false);
    expect(needsDarwinE2E(["packages/serve-sim/src/__tests__/grid-panel.test.tsx"])).toBe(false);
    expect(needsDarwinE2E(["README.md", "packages/serve-sim/docs/scroll-injection-devicehub.md"])).toBe(false);
    expect(needsDarwinE2E(["packages/serve-sim/Sources/SimNative/HIDInjector.swift"])).toBe(true);
    expect(needsDarwinE2E(["packages/serve-sim/src/middleware.ts"])).toBe(true);
    expect(needsDarwinE2E(["packages/serve-sim/src/__tests__/idle-floor.test.ts"])).toBe(true);
    expect(needsDarwinE2E([
      "packages/serve-sim/src/client/client.tsx",
      "packages/serve-sim/src/native.ts",
    ])).toBe(true);
    expect(isDarwinSkipPath("packages/serve-sim/src/client/utils/hid.ts")).toBe(true);
  });
});

describe("CI workflow factory invariants", () => {
  test("Ubuntu unit job has no --max-concurrency=1", () => {
    const unit = workflow("serve-sim-unit.yml");
    expect(unit).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(unit).toMatch(/bun test packages\/serve-sim\/src\/__tests__\//);
    expect(unit).not.toMatch(/max-concurrency=1/);
  });

  test("macOS e2e uses the per-file runner, not a serial full-tree bun test", () => {
    const sim = workflow("sim-test.yml");
    expect(sim).toMatch(/runs-on:\s*macos-26/);
    expect(sim).toContain("scripts/run-sim-e2e.ts");
    expect(sim).not.toMatch(/bun test --max-concurrency=1 packages\/serve-sim\/src\/__tests__\//);
  });

  test("sim-test.yml path filters include every Darwin test file and exclude client-only", () => {
    const sim = workflow("sim-test.yml");
    for (const file of [...SIM_E2E_TEST_FILES, ...DARWIN_INTEGRATION_TEST_FILES]) {
      expect(sim).toContain(file);
    }
    expect(sim).toContain("packages/serve-sim/src/*.ts");
    expect(sim).toContain("packages/serve-sim/Sources/**");
    expect(sim).toContain("packages/serve-sim/Package.resolved");
    expect(sim).not.toMatch(/packages\/serve-sim\/src\/client\/\*\*/);
  });

  test("CI test builds are arm64; npm publish stays universal", () => {
    const action = actionYml();
    expect(action).toMatch(/default:\s*arm64/);
    expect(action).toContain("SERVE_SIM_ARCH");

    const sim = workflow("sim-test.yml");
    expect(sim).toMatch(/arch:\s*arm64/);

    for (const name of ["publish.yml", "publish-stable.yml"] as const) {
      const yml = workflow(name);
      expect(yml).toContain("build-serve-sim-for-ci");
      expect(yml).toMatch(/arch:\s*arm64/);
      const publishStep = yml.split("Build and publish")[1] ?? "";
      expect(publishStep).toMatch(/bun run build/);
      expect(publishStep).not.toMatch(/SERVE_SIM_ARCH:\s*arm64/);
    }
  });

  test("simulator boot overlaps the native build", () => {
    const action = actionYml();
    const startIdx = action.indexOf("- name: Start iOS simulator boot");
    const buildIdx = action.indexOf("- name: Build serve-sim");
    const waitIdx = action.indexOf("- name: Wait for iOS simulator");
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(startIdx);
    expect(waitIdx).toBeGreaterThan(buildIdx);
  });

  test("SwiftPM cache key includes OS, Package.resolved, Swift sources, and toolchain", () => {
    const action = actionYml();
    expect(action).toContain("packages/serve-sim/.build");
    expect(action).toContain("uses: actions/cache/restore@v4");
    expect(action).toContain("uses: actions/cache/save@v4");
    expect(action).toContain("swift --version");
    expect(action).toContain("xcodebuild -version");
    expect(action).toContain("packages/serve-sim/Package.resolved");
    expect(action).toContain("packages/serve-sim/Package.swift");
    expect(action).toContain("packages/serve-sim/Sources/SimNative/**");
    expect(action).toContain("packages/serve-sim/Sources/SimNativeSupport/**");
  });

  test("wait-ios-simulator.sh succeeds on a done marker and fails on failed/timeout", () => {
    const wait = join(REPO, ".github/scripts/wait-ios-simulator.sh");
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-boot-"));
    writeFileSync(join(dir, "udid"), "TEST-UDID\n");
    writeFileSync(join(dir, "done"), "");
    const ok = execFileSync("bash", [wait], {
      encoding: "utf-8",
      env: { ...process.env, SERVE_SIM_BOOT_DIR: dir },
    });
    expect(ok).toContain("TEST-UDID");

    rmSync(join(dir, "done"));
    writeFileSync(join(dir, "failed"), "");
    writeFileSync(join(dir, "log"), "boom\n");
    expect(() =>
      execFileSync("bash", [wait], {
        env: { ...process.env, SERVE_SIM_BOOT_DIR: dir },
      }),
    ).toThrow();

    rmSync(join(dir, "failed"));
    try {
      execFileSync("bash", [wait], {
        encoding: "utf-8",
        env: {
          ...process.env,
          SERVE_SIM_BOOT_DIR: dir,
          SERVE_SIM_BOOT_TIMEOUT_SEC: "0",
        },
      });
      throw new Error("expected wait-ios-simulator.sh to time out");
    } catch (error) {
      const err = error as { message?: string; stderr?: string };
      expect(`${err.stderr ?? ""}\n${err.message ?? ""}`).toMatch(/Timed out/);
    }
  });

  test("probe-swiftpm-cache.sh refuses to run without .build", () => {
    const probe = join(REPO, ".github/scripts/probe-swiftpm-cache.sh");
    expect(existsSync(probe)).toBe(true);
    // The real packages/serve-sim/.build is gitignored and absent in this
    // checkout, so the probe should error out instead of claiming a warm hit.
    expect(() => execFileSync("bash", [probe], { encoding: "utf-8" })).toThrow();
  });

  test("every file under src/__tests__ is either a Darwin e2e/integration test or a unit test", () => {
    const dir = join(REPO, "packages/serve-sim/src/__tests__");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const rel = `packages/serve-sim/src/__tests__/${file}`;
      if (file.includes(".e2e.") || file.endsWith("-sim.test.ts") || file.includes(".integration.")) {
        expect(isDarwinTestFile(rel)).toBe(true);
      }
    }
    // Named e2e/sim/integration files must not be forgotten if someone adds one.
    for (const file of files) {
      if (/\.e2e\.test\.tsx?$/.test(file) || /-sim\.test\.tsx?$/.test(file) || /\.integration\.test\.tsx?$/.test(file)) {
        expect(isDarwinTestFile(`packages/serve-sim/src/__tests__/${file}`)).toBe(true);
      }
    }
  });
});
