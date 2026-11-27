import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clangArchArgs, parseServeSimArch } from "../serve-sim-arch";
import { simctlArguments } from "../simctl";

const BUNDLE_ID = "dev.servesim.camera-connection-test";
const RESULT_FILE = "simcam-connection-result.json";
const PKG_DIR = join(import.meta.dir, "../..");
const DYLIB = join(PKG_DIR, "dist/simcam/libSimCameraInjector.dylib");
const TEST_SOURCE = join(PKG_DIR, "Tests/SimCameraConnectionTestApp/main.m");

function bootedUdid(): string | null {
  try {
    const out = execFileSync("xcrun", simctlArguments(["list", "devices", "booted", "-j"]), { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!/iOS/i.test(runtime)) continue;
      for (const device of devices) {
        if (device.state === "Booted") return device.udid;
      }
    }
  } catch {}
  return null;
}

const udid = bootedUdid();
const describeIfSimulator = udid && existsSync(DYLIB) ? describe : describe.skip;
let buildDir: string | null = null;
let resultPath: string | null = null;

// A test here takes 0.4-2s on a dev Mac, but 4-20s on GitHub's shared macOS
// runners, where launches ran past the old 8s cap and tests past bun's 20s.
// A throttled local sim (guest at background QoS) reproduced 1.8-19s tests
// and >8s launches. CI budgets: terminate 5s + launch 20s + result 12s, plus
// the launchd query, fit the 45s test timeout.
const ON_CI = !!process.env.CI;
const TEST_TIMEOUT_MS = ON_CI ? 45_000 : 20_000;
/** Under TEST_TIMEOUT_MS, with room for terminate and launchdJob(5_000) around it. */
const LAUNCH_TIMEOUT_MS = ON_CI ? 20_000 : 8_000;
const RESULT_TIMEOUT_MS = ON_CI ? 12_000 : 10_000;
const TERMINATE_TIMEOUT_MS = 5_000;
const BEFORE_ALL_TIMEOUT_MS = 120_000;
const AFTER_ALL_TIMEOUT_MS = 30_000;
// 17 tests x 45s plus hooks, twice with the runner's retry, would overrun the
// 25-minute job on a wedged sim. After this many launch failures or missing
// results in a row, fail the rest at once.
const MAX_CONSECUTIVE_STALLS = 3;
let consecutiveStalls = 0;

/**
 * Runs hook steps against one deadline. bun can't stop a hook blocked in a
 * synchronous child, so every step gets the time left as its own timeout;
 * a stalled step (CI: a retry's setup ran 159s against a 120s hook timeout)
 * fails the hook in budget, naming the step and what each step took.
 */
function hookSteps(hook: string, budgetMs: number) {
  const started = Date.now();
  const deadline = started + budgetMs - 2_000;
  const done: string[] = [];
  const summary = () => done.join(", ") || "none";
  return {
    run<T>(name: string, step: (timeoutMs: number) => T): T {
      const at = Date.now();
      const timeoutMs = Math.max(1_000, deadline - at);
      try {
        const value = step(timeoutMs);
        done.push(`${name} ${Date.now() - at}ms`);
        return value;
      } catch (e) {
        throw new Error(
          `${hook} step "${name}" failed after ${Date.now() - at}ms (timeout ${timeoutMs}ms, ` +
            `${Date.now() - started}ms into the hook); steps done: ${summary()}: ${(e as Error).message ?? e}`,
          { cause: e },
        );
      }
    },
    log() {
      console.log(`camera e2e ${hook} took ${Date.now() - started}ms: ${summary()}`);
    },
  };
}

/** The test app's `launchctl list` line in the guest, "none", or why the query failed. */
function launchdJob(timeoutMs: number): string {
  const running = spawnSync("xcrun", simctlArguments(["spawn", udid!, "launchctl", "list"]), { encoding: "utf-8", timeout: timeoutMs });
  if (running.error || running.status !== 0 || running.signal) {
    return `query failed (${running.error?.message ?? `status ${running.status} signal ${running.signal}`}): ` +
      `${(running.stderr ?? "").trim()}`;
  }
  return (running.stdout ?? "").split("\n").find((line) => line.includes(BUNDLE_ID))?.trim() ?? "none";
}

async function runTestApp(
  mode:
    | "graph"
    | "teardown"
    | "automatic-recording"
    | "manual-recording"
    | "max-duration-recording"
    | "max-file-size-recording"
    | "existing-file-recording"
    | "writer-failure-recording"
    | "dropped-output-recording"
    | "stopped-session-recording"
    | "released-session-recording"
    | "removed-camera-recording"
    | "moved-output-recording"
    | "not-running-recording"
    | "foreign-connection-settings"
    | "unique-id-lookup"
    | "format-description",
) {
  if (consecutiveStalls >= MAX_CONSECUTIVE_STALLS) {
    throw new Error(`not run: the previous ${consecutiveStalls} tests stalled (launch failed or no result); the simulator looks wedged`);
  }
  const started = Date.now();
  try {
    execFileSync("xcrun", simctlArguments(["terminate", udid!, BUNDLE_ID]), {
      stdio: "pipe",
      timeout: TERMINATE_TIMEOUT_MS,
    });
  } catch {}
  if (resultPath) {
    try {
      unlinkSync(resultPath);
    } catch {}
  }

  const launchAt = Date.now();
  let launched: string;
  try {
    // A normal launch takes ~1-4s. On CI it has hung until bun's test
    // timeout (SIGTERM, no output), which loses every diagnostic below, so
    // stop it at LAUNCH_TIMEOUT_MS and leave the 5s launchd query room.
    launched = execFileSync("xcrun", simctlArguments(["launch", udid!, BUNDLE_ID]), {
      encoding: "utf-8",
      timeout: LAUNCH_TIMEOUT_MS,
      env: {
        ...process.env,
        SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: DYLIB,
        SIMCTL_CHILD_SIMCAM_CONNECTION_TEST_MODE: mode,
      },
    });
  } catch (e) {
    consecutiveStalls++;
    const err = e as { message?: string; signal?: string | null; status?: number | null; stdout?: unknown; stderr?: unknown };
    let job: string;
    try {
      job = launchdJob(5_000);
    } catch (diag) {
      job = `diagnostics failed: ${diag}`;
    }
    throw new Error(
      `simctl launch for mode ${mode} failed after ${Date.now() - launchAt}ms ` +
        `(timeout ${LAUNCH_TIMEOUT_MS}ms, terminate took ${launchAt - started}ms; ` +
        `status ${err.status ?? null} signal ${err.signal ?? null}): ${err.message ?? String(e)}\n` +
        `stdout: ${String(err.stdout ?? "").trim()}\nstderr: ${String(err.stderr ?? "").trim()}\n` +
        `launchd job: ${job}`,
      { cause: e },
    );
  }

  const launchedAt = Date.now();
  const deadline = launchedAt + RESULT_TIMEOUT_MS;
  while (resultPath && !existsSync(resultPath) && Date.now() < deadline) {
    await Bun.sleep(100);
  }
  // Per-phase times on every run, so CI logs show which phase eats the budget.
  console.log(
    `camera e2e ${mode}: terminate ${launchAt - started}ms, launch ${launchedAt - launchAt}ms, ` +
      `result ${Date.now() - launchedAt}ms`,
  );
  // A missing result used to say only "Expected: true". Say where the time
  // went (terminate, launch, wait) and whether the app is still running.
  // Fit the launchd query in what's left of the test budget, keeping 1s
  // to report the failure, so bun's timeout doesn't swallow the message.
  const missing = () => {
    const remaining = TEST_TIMEOUT_MS - (Date.now() - started) - 1_000;
    const job = remaining >= 500 ? launchdJob(remaining) : "not queried (test budget exhausted)";
    return `no ${RESULT_FILE} from mode ${mode} ${Date.now() - launchedAt}ms after launch ` +
      `(terminate ${launchAt - started}ms, launch ${launchedAt - launchAt}ms: ${launched.trim()}); ` +
      `launchd job: ${job}`;
  };
  const found = !!resultPath && existsSync(resultPath);
  consecutiveStalls = found ? 0 : consecutiveStalls + 1;
  expect(found, found ? "" : missing()).toBe(true);
  const result = JSON.parse(readFileSync(resultPath!, "utf-8")) as {
    passed: boolean;
    message: string;
  };
  expect(result.passed, result.message).toBe(true);
}

describeIfSimulator("synthetic camera connection graph", () => {
  beforeAll(() => {
    const steps = hookSteps("beforeAll", BEFORE_ALL_TIMEOUT_MS);
    buildDir = mkdtempSync(join(tmpdir(), "serve-sim-camera-connection-test-"));
    const appDir = join(buildDir, "SimCameraConnectionTest.app");
    execFileSync("mkdir", ["-p", appDir]);

    const sdk = steps.run("sdk path", (timeout) => execFileSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], {
      encoding: "utf-8",
      timeout,
    }).trim());
    const arch = parseServeSimArch();
    const archArgs = clangArchArgs(arch);
    console.log(`camera e2e clang SERVE_SIM_ARCH=${arch} args=${JSON.stringify(archArgs)}`);
    steps.run("clang", (timeout) => execFileSync("xcrun", [
      "--sdk", "iphonesimulator", "clang",
      ...archArgs,
      "-mios-simulator-version-min=15.0",
      "-isysroot", sdk,
      "-fobjc-arc", "-fmodules",
      "-framework", "Foundation",
      "-framework", "UIKit",
      "-framework", "AVFoundation",
      "-o", join(appDir, "SimCameraConnectionTest"),
      TEST_SOURCE,
    ], { timeout }));
    writeFileSync(join(appDir, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>SimCameraConnectionTest</string>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>SimCameraConnectionTest</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSRequiresIPhoneOS</key><true/>
<key>MinimumOSVersion</key><string>15.0</string>
<key>NSMicrophoneUsageDescription</key><string>Records the microphone beside the synthetic camera.</string>
<key>UIApplicationSceneManifest</key><dict>
<key>UIApplicationSupportsMultipleScenes</key><false/>
<key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict>
<key>UISceneConfigurationName</key><string>Default</string>
<key>UISceneDelegateClassName</key><string>SimCameraConnectionSceneDelegate</string>
</dict></array></dict></dict>
</dict></plist>\n`);

    try {
      steps.run("uninstall", (timeout) => execFileSync("xcrun", simctlArguments(["uninstall", udid!, BUNDLE_ID]), { timeout }));
    } catch {}
    steps.run("install", (timeout) => execFileSync("xcrun", simctlArguments(["install", udid!, appDir]), { timeout }));
    // The recording checks add the microphone, as expo-camera and
    // VisionCamera do; a host without one skips that half.
    steps.run("privacy grant", (timeout) =>
      execFileSync("xcrun", simctlArguments(["privacy", udid!, "grant", "microphone", BUNDLE_ID]), { timeout }));
    const dataContainer = steps.run("get_app_container", (timeout) => execFileSync(
      "xcrun",
      simctlArguments(["get_app_container", udid!, BUNDLE_ID, "data"]),
      { encoding: "utf-8", timeout },
    ).trim());
    resultPath = join(dataContainer, "Documents", RESULT_FILE);
    try {
      unlinkSync(resultPath);
    } catch {}
    steps.log();
  }, BEFORE_ALL_TIMEOUT_MS);

  afterAll(() => {
    const steps = hookSteps("afterAll", AFTER_ALL_TIMEOUT_MS);
    try {
      steps.run("uninstall", (timeout) => execFileSync("xcrun", simctlArguments(["uninstall", udid!, BUNDLE_ID]), { timeout }));
    } catch (e) {
      console.warn(`camera e2e: ${(e as Error).message}`);
    }
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
    steps.log();
  }, AFTER_ALL_TIMEOUT_MS);

  test("preserves no-connections state until the explicit connection is added", async () => {
    await runTestApp("graph");
  }, TEST_TIMEOUT_MS);

  test("deallocates automatic metadata and video outputs without crashing", async () => {
    await runTestApp("teardown");
  }, TEST_TIMEOUT_MS);

  test("records a movie from automatic connections beside a microphone (expo-camera)", async () => {
    await runTestApp("automatic-recording");
  }, TEST_TIMEOUT_MS);

  test("records a movie from manual connections with a paused stretch (VisionCamera 5)", async () => {
    await runTestApp("manual-recording");
  }, TEST_TIMEOUT_MS);

  test("stops a movie at maxRecordedDuration as a successful recording", async () => {
    await runTestApp("max-duration-recording");
  }, TEST_TIMEOUT_MS);

  test("stops a movie at maxRecordedFileSize as a successful recording", async () => {
    await runTestApp("max-file-size-recording");
  }, TEST_TIMEOUT_MS);

  test("refuses to record over an existing file, as AVFoundation does", async () => {
    await runTestApp("existing-file-recording");
  }, TEST_TIMEOUT_MS);

  test("ends the recording with the writer's error when a write fails", async () => {
    await runTestApp("writer-failure-recording");
  }, TEST_TIMEOUT_MS);

  test("finishes the movie when the app drops its output mid-recording (expo-camera remount)", async () => {
    await runTestApp("dropped-output-recording");
  }, TEST_TIMEOUT_MS);

  test("finishes the movie when the app stops its session mid-recording and lets it go", async () => {
    await runTestApp("stopped-session-recording");
  }, TEST_TIMEOUT_MS);

  test("finishes the movie when the app lets its running session go", async () => {
    await runTestApp("released-session-recording");
  }, TEST_TIMEOUT_MS);

  test("finishes the movie when the app removes the camera mid-recording", async () => {
    await runTestApp("removed-camera-recording");
  }, TEST_TIMEOUT_MS);

  test("keeps an output in one session at a time, as AVFoundation does", async () => {
    await runTestApp("moved-output-recording");
  }, TEST_TIMEOUT_MS);

  test("refuses to record on a stopped session with AVErrorSessionNotRunning", async () => {
    await runTestApp("not-running-recording");
  }, TEST_TIMEOUT_MS);

  test("ignores output settings for another output's connection, as AVFoundation does", async () => {
    await runTestApp("foreign-connection-settings");
  }, TEST_TIMEOUT_MS);

  test("finds the fake cameras by unique ID, and only them", async () => {
    await runTestApp("unique-id-lookup");
  }, TEST_TIMEOUT_MS);

  test("can log a fake format", async () => {
    await runTestApp("format-description");
  }, TEST_TIMEOUT_MS);
});
