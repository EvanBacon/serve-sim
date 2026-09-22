#!/usr/bin/env bun
/**
 * macOS CI runner for real-sim / native helper tests.
 *
 * Camera-helper integration shares one spawned process via beforeAll, so it
 * stays serial (`--max-concurrency=1`) just like sim-backed e2e. E2e files
 * run one at a time; a failure reboots the shared simulator and retries that
 * file once so a wedged finger / native crash does not force a full-tree rerun.
 */
import { spawnSync } from "child_process";
import { resolve } from "path";
import {
  DARWIN_INTEGRATION_TEST_FILES,
  SIM_E2E_TEST_FILES,
} from "../src/ci-test-plan";

const repoRoot = resolve(import.meta.dir, "../../..");
const udid = process.env.UDID ?? "";
const serialArgs = ["--max-concurrency=1"];
const failed: string[] = [];

function runBunTest(files: readonly string[], extraArgs: string[] = []): number {
  const result = spawnSync("bun", ["test", ...extraArgs, ...files], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

function alreadyBooted(result: ReturnType<typeof spawnSync>): boolean {
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /current state: Booted|already booted/i.test(text);
}

function rebootSimulator(): boolean {
  if (!udid) {
    console.error("UDID unset; cannot reboot simulator for retry");
    return false;
  }
  console.warn(`Rebooting simulator ${udid} before retry`);
  spawnSync("xcrun", ["simctl", "shutdown", udid], { stdio: "inherit" });
  spawnSync("sleep", ["3"], { stdio: "inherit" });
  const boot = spawnSync("xcrun", ["simctl", "boot", udid], { encoding: "utf-8" });
  if (boot.stdout) process.stdout.write(boot.stdout);
  if (boot.stderr) process.stderr.write(boot.stderr);
  // Shutdown can lose the race with a detached server. "Already booted" is a
  // usable simulator, not a reason to skip the retry.
  if (boot.status !== 0 && !alreadyBooted(boot)) {
    console.error(`simctl boot ${udid} failed (status ${boot.status}); skipping retry`);
    return false;
  }
  // No `-b`: on Xcode 27 the boot-and-monitor form can stay blocked after the
  // device is already Booted.
  const bootstatus = spawnSync("xcrun", ["simctl", "bootstatus", udid], {
    stdio: "inherit",
    timeout: 90_000,
  });
  if (bootstatus.status !== 0) {
    console.error(`simctl bootstatus ${udid} failed (status ${bootstatus.status}); skipping retry`);
    return false;
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

if (failed.length > 0) {
  console.error(`Darwin tests failed after retry:\n${failed.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
