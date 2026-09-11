#!/usr/bin/env bun
/**
 * macOS CI runner for real-sim / native helper tests.
 *
 * Integration tests (camera helper shm probe) do not share the simulator and
 * run with default bun concurrency. Sim-backed e2e files run one at a time;
 * a failure reboots the shared simulator and retries that file once so a
 * wedged finger / native crash does not force a full-tree rerun.
 */
import { spawnSync } from "child_process";
import { resolve } from "path";
import {
  DARWIN_INTEGRATION_TEST_FILES,
  SIM_E2E_TEST_FILES,
} from "../src/ci-test-plan";

const repoRoot = resolve(import.meta.dir, "../../..");
const udid = process.env.UDID ?? "";

function runBunTest(files: readonly string[], extraArgs: string[] = []): number {
  const result = spawnSync("bun", ["test", ...extraArgs, ...files], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

function rebootSimulator(): void {
  if (!udid) {
    console.warn("UDID unset; skipping simulator reboot");
    return;
  }
  console.warn(`Rebooting simulator ${udid} before retry`);
  spawnSync("xcrun", ["simctl", "shutdown", udid], { stdio: "inherit" });
  spawnSync("sleep", ["3"], { stdio: "inherit" });
  spawnSync("xcrun", ["simctl", "boot", udid], { stdio: "inherit" });
  spawnSync("xcrun", ["simctl", "bootstatus", udid, "-b"], { stdio: "inherit" });
  spawnSync("open", ["-ga", "Simulator"], { stdio: "inherit" });
}

if (DARWIN_INTEGRATION_TEST_FILES.length > 0) {
  console.log("Darwin integration tests (default concurrency)");
  const status = runBunTest(DARWIN_INTEGRATION_TEST_FILES);
  if (status !== 0) process.exit(status);
}

const failed: string[] = [];
for (const file of SIM_E2E_TEST_FILES) {
  console.log(`\n=== sim e2e ${file} ===`);
  if (runBunTest([file], ["--max-concurrency=1"]) === 0) continue;
  console.warn(`::warning title=sim e2e retry::${file} failed; rebooting and retrying once`);
  rebootSimulator();
  if (runBunTest([file], ["--max-concurrency=1"]) === 0) continue;
  failed.push(file);
}

if (failed.length > 0) {
  console.error(`Sim e2e failed after retry:\n${failed.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
