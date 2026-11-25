#!/usr/bin/env bun
/**
 * macOS CI runner for real-sim / native helper tests.
 *
 * Camera-helper integration shares one spawned process via beforeAll, so it
 * stays serial (`--max-concurrency=1`) just like sim-backed e2e. E2e files
 * run one at a time; a failure reboots the shared simulator and retries that
 * file once so a wedged finger / native crash does not force a full-tree rerun.
 * The shutdown e2e goes last because it shuts the simulator down and boots it
 * again; it is opted in here on the CI-owned simulator only.
 */
import { spawnSync } from "child_process";
import { resolve } from "path";
import {
  DARWIN_INTEGRATION_TEST_FILES,
  SIM_E2E_TEST_FILES,
  SIM_SHUTDOWN_E2E_TEST_FILE,
  bootstatusOutcome,
  describeSimulatorState,
} from "../src/ci-test-plan";

const repoRoot = resolve(import.meta.dir, "../../..");
const udid = process.env.UDID ?? "";
const serialArgs = ["--max-concurrency=1"];
const failed: string[] = [];

function runBunTest(
  files: readonly string[],
  extraArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): number {
  const result = spawnSync("bun", ["test", ...extraArgs, ...files], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  return result.status ?? 1;
}

function alreadyBooted(result: ReturnType<typeof spawnSync>): boolean {
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /current state: Booted|already booted/i.test(text);
}

/** Run a reboot step, logging how long it took and how it exited. */
function timed<T extends ReturnType<typeof spawnSync>>(step: string, run: () => T): T {
  const start = Date.now();
  const result = run();
  const exit = result.signal ? `signal ${result.signal}` : `status ${result.status}`;
  console.warn(`reboot step ${step}: ${exit} after ${Date.now() - start}ms`);
  return result;
}

/** `simctl list devices -j` output, or undefined if simctl failed. */
function listDevices(): string | undefined {
  const list = spawnSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf-8", timeout: 30_000 });
  return list.status === 0 ? list.stdout : undefined;
}

/** The simulator's state per `simctl list`, for failure logs. */
function simulatorState(listJson = listDevices()): string {
  if (listJson === undefined) return `${udid} state unknown (simctl list failed)`;
  return describeSimulatorState(listJson, udid);
}

/**
 * Whether the simulator's launchd answers `simctl spawn` within 30s. Used when
 * bootstatus hung on a device that `simctl list` already reports as Booted.
 */
function probeReady(): boolean {
  const deadline = Date.now() + 30_000;
  for (let attempt = 1; ; attempt++) {
    const probe = timed(`readiness probe ${attempt}`, () =>
      spawnSync("xcrun", ["simctl", "spawn", udid, "launchctl", "print", "system"], {
        stdio: "ignore",
        // Never run past the 30s deadline, however late the last try starts.
        timeout: Math.min(10_000, Math.max(1_000, deadline - Date.now())),
      }),
    );
    if (probe.status === 0) return true;
    if (Date.now() + 2_000 >= deadline) return false;
    spawnSync("sleep", ["2"]);
  }
}

function rebootSimulator(): boolean {
  if (!udid) {
    console.error("UDID unset; cannot reboot simulator for retry");
    return false;
  }
  console.warn(`Rebooting simulator ${udid} before retry (${simulatorState()})`);
  timed("shutdown", () => spawnSync("xcrun", ["simctl", "shutdown", udid], { stdio: "inherit" }));
  spawnSync("sleep", ["3"], { stdio: "inherit" });
  const boot = timed("boot", () => spawnSync("xcrun", ["simctl", "boot", udid], { encoding: "utf-8" }));
  if (boot.stdout) process.stdout.write(boot.stdout);
  if (boot.stderr) process.stderr.write(boot.stderr);
  // Shutdown can lose the race with a detached server. "Already booted" is a
  // usable simulator, not a reason to skip the retry.
  if (boot.status !== 0 && !alreadyBooted(boot)) {
    console.error(`simctl boot ${udid} failed (status ${boot.status}); skipping retry (${simulatorState()})`);
    return false;
  }
  // No `-b`: on Xcode 27 the boot-and-monitor form can stay blocked after the
  // device is already Booted. Plain bootstatus can too: on the macOS runner
  // (iOS 26.4) it hung until the timeout killed it with the device Booted.
  // A healthy reboot finishes it in seconds, so 60s is plenty before falling
  // back to the probe.
  const bootstatus = timed("bootstatus", () => spawnSync("xcrun", ["simctl", "bootstatus", udid], {
    stdio: "inherit",
    timeout: 60_000,
  }));
  if (bootstatus.status !== 0) {
    const listJson = listDevices();
    const failure = `simctl bootstatus ${udid} failed (status ${bootstatus.status}, signal ${bootstatus.signal})`;
    if (bootstatusOutcome(bootstatus.status, listJson, udid) !== "probe") {
      console.error(`${failure}; skipping retry (${simulatorState(listJson)})`);
      return false;
    }
    if (!probeReady()) {
      console.error(`${failure} and the readiness probe failed; skipping retry (${simulatorState()})`);
      return false;
    }
    console.warn(`${failure}, but ${udid} is Booted and answers simctl spawn; overriding bootstatus and retrying`);
  }
  spawnSync("open", ["-ga", "Simulator"], { stdio: "inherit" });
  return true;
}

for (const file of DARWIN_INTEGRATION_TEST_FILES) {
  console.log(`\n=== darwin integration ${file} ===`);
  if (runBunTest([file], serialArgs) === 0) continue;
  console.warn(`::warning title=darwin integration retry::${file} failed; retrying once`);
  if (runBunTest([file], serialArgs) === 0) continue;
  failed.push(file);
}

for (const file of SIM_E2E_TEST_FILES) {
  console.log(`\n=== sim e2e ${file} ===`);
  if (runBunTest([file], serialArgs) === 0) continue;
  console.warn(`::warning title=sim e2e retry::${file} failed; rebooting and retrying once`);
  if (!rebootSimulator()) {
    console.error(`Simulator reboot failed; not retrying ${file}`);
    failed.push(file);
    continue;
  }
  if (runBunTest([file], serialArgs) === 0) continue;
  failed.push(file);
}

// Last: it shuts the simulator down. A failure gets the same reboot + one retry.
if (udid) {
  const file = SIM_SHUTDOWN_E2E_TEST_FILE;
  const env = { ...process.env, SERVE_SIM_E2E_SHUTDOWN_UDID: udid };
  console.log(`\n=== sim e2e ${file} (shuts down ${udid}) ===`);
  if (runBunTest([file], serialArgs, env) !== 0) {
    console.warn(`::warning title=sim e2e retry::${file} failed; rebooting and retrying once`);
    if (!rebootSimulator() || runBunTest([file], serialArgs, env) !== 0) failed.push(file);
  }
} else {
  console.warn(`UDID unset; skipping ${SIM_SHUTDOWN_E2E_TEST_FILE}`);
}

if (failed.length > 0) {
  console.error(`Darwin tests failed after retry:\n${failed.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
