import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/**
 * After `simctl shutdown`, SimDeviceLegacyHIDClient keeps accepting sends, so
 * `serve-sim tap` exited 0 for ~5-15s — until the detached server's
 * --exit-on-simulator-shutdown watcher exited. The injector now drops input once
 * SimDevice.state leaves Booted, so the CLI fails within ~1s while the server is
 * still up.
 *
 * Opt-in because it shuts the simulator down: set SERVE_SIM_E2E_SHUTDOWN_UDID to
 * a booted (or bootable) iOS simulator this test may shut down — never a shared one.
 */

const CLI = join(import.meta.dir, "../../dist/serve-sim.js");
const udid = process.env.SERVE_SIM_E2E_SHUTDOWN_UDID;
const describeIfOptedIn = udid && existsSync(CLI) ? describe : describe.skip;

function tap(): { status: number | null; stderr: string } {
  const r = spawnSync("node", [CLI, "tap", "0.97", "0.03", "-d", udid!], { encoding: "utf-8", timeout: 15_000 });
  return { status: r.status, stderr: r.stderr ?? "" };
}

describeIfOptedIn(`HID input after simctl shutdown (${udid ?? "<skipped>"})`, () => {
  beforeAll(async () => {
    spawnSync("xcrun", ["simctl", "boot", udid!], { stdio: "ignore" });
    execFileSync("xcrun", ["simctl", "bootstatus", udid!, "-b"], { stdio: "ignore", timeout: 120_000 });
    try { execFileSync("node", [CLI, "--kill", udid!], { stdio: "pipe" }); } catch {}
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const detach = spawnSync("node", [CLI, "--detach", "-p", String(port), udid!], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"], timeout: 45_000,
    });
    if (detach.status !== 0) throw new Error(`serve-sim --detach failed: ${detach.stdout}`);
  }, 180_000);

  afterAll(() => {
    try { execFileSync("node", [CLI, "--kill", udid!], { stdio: "pipe" }); } catch {}
  }, 30_000);

  test("tap fails with an undelivered error within ~1s of shutdown", async () => {
    expect(tap().status).toBe(0);

    const shutdown = spawn("xcrun", ["simctl", "shutdown", udid!], { stdio: "ignore" });
    const issued = Date.now();
    let failure: { afterMs: number; stderr: string } | undefined;
    while (Date.now() - issued < 2_000) {
      const r = tap();
      if (r.status !== 0) { failure = { afterMs: Date.now() - issued, stderr: r.stderr }; break; }
    }
    await new Promise((r) => shutdown.on("exit", r));

    // The server must still be answering — a "No serve-sim server" failure
    // would only mean the shutdown watcher already exited.
    if (!failure) throw new Error("every tap in the 2s after `simctl shutdown` exited 0");
    expect(failure.stderr).toContain("could not deliver the tap");
    expect(failure.afterMs).toBeLessThan(2_000);
  }, 60_000);
});
