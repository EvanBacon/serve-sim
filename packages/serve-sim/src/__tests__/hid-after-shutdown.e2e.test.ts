import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execFileSync, spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/**
 * After `simctl shutdown`, SimDeviceLegacyHIDClient keeps accepting sends, so
 * `serve-sim tap` exited 0 until the server went away. Its port also stays dead
 * after the same device boots again, so a server that stayed up (foreground,
 * not --detach) acked taps that never reached the guest. The injector now
 * drops input while the device isn't Booted and rebuilds the client when it
 * comes back.
 *
 * Opt-in because it shuts the simulator down and boots it again: set
 * SERVE_SIM_E2E_SHUTDOWN_UDID to an iOS simulator this test may restart, never a
 * shared one. CI runs it last on its own simulator (scripts/run-sim-e2e.ts).
 */

const CLI = join(import.meta.dir, "../../dist/serve-sim.js");
const udid = process.env.SERVE_SIM_E2E_SHUTDOWN_UDID;
if (udid && !existsSync(CLI)) {
  throw new Error(`SERVE_SIM_E2E_SHUTDOWN_UDID is set but ${CLI} is missing; build the CLI first`);
}
const describeIfOptedIn = udid ? describe : describe.skip;
const RECONNECTED = "[hid] Simulator Booted again, reconnected HID client";
const NO_SERVER = "No serve-sim server running";

function tap(): { status: number | null; stderr: string } {
  const r = spawnSync("node", [CLI, "tap", "0.97", "0.03", "-d", udid!], { encoding: "utf-8", timeout: 15_000 });
  return { status: r.status, stderr: r.stderr ?? "" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Boot and wait. No `bootstatus -b`: on Xcode 27 it can stay blocked once Booted. */
function bootAndWait(): void {
  spawnSync("xcrun", ["simctl", "boot", udid!], { stdio: "ignore" });
  execFileSync("xcrun", ["simctl", "bootstatus", udid!], { stdio: "ignore", timeout: 120_000 });
}

async function tapUntilOk(timeoutMs: number): Promise<{ status: number | null; stderr: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = tap();
  while (last.status !== 0 && Date.now() < deadline) {
    await sleep(500);
    last = tap();
  }
  return last;
}

describeIfOptedIn(`HID input across simctl shutdown + boot (${udid ?? "<skipped>"})`, () => {
  let server: ChildProcess | undefined;
  let serverLog = "";

  beforeAll(async () => {
    bootAndWait();
    try { execFileSync("node", [CLI, "--kill", udid!], { stdio: "pipe" }); } catch {}
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    // Foreground (no --detach): unlike a detached helper it has no
    // --exit-on-simulator-shutdown watcher, so it stays up across the reboot.
    server = spawn("node", [CLI, udid!, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    server.stdout!.on("data", (d) => { serverLog += d; });
    server.stderr!.on("data", (d) => { serverLog += d; });
    const ready = await tapUntilOk(45_000);
    if (ready.status !== 0) throw new Error(`serve-sim server never accepted a tap: ${ready.stderr}\n${serverLog}`);
  }, 240_000);

  afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([new Promise((r) => server!.once("exit", r)), sleep(5_000)]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    try { execFileSync("node", [CLI, "--kill", udid!], { stdio: "pipe" }); } catch {}
    // Leave the simulator booted, as the test found it.
    bootAndWait();
  }, 180_000);

  test("tap fails with an undelivered error within 2s of shutdown, while the server is up", async () => {
    // The bound is 2s because a correct drop is fast (locally ~0.4–1.2s,
    // including CLI startup). On macos-26 CI, a synchronous SimDevice.state
    // read during `simctl shutdown` blocked the first tap for 6312ms; the
    // gate now times that read out at 100ms, so this bound stays at 2s.
    expect(tap().status).toBe(0);

    const shutdown = spawn("xcrun", ["simctl", "shutdown", udid!], { stdio: "ignore" });
    const issued = Date.now();
    let failure: { afterMs: number; stderr: string } | undefined;
    while (Date.now() - issued < 2_000) {
      const r = tap();
      if (r.status !== 0) { failure = { afterMs: Date.now() - issued, stderr: r.stderr }; break; }
    }
    await new Promise((r) => shutdown.on("exit", r));

    if (!failure) throw new Error("every tap in the 2s after `simctl shutdown` exited 0");
    expect(failure.afterMs).toBeLessThan(2_000);
    // The injector refused the tap, so the server was answering.
    expect(failure.stderr).toContain("could not deliver the tap");
    expect(failure.stderr).not.toContain(NO_SERVER);
    expect(server!.exitCode).toBeNull();
    // It still answers once the device is fully down.
    const down = tap();
    expect(down.status).not.toBe(0);
    expect(down.stderr).toContain("could not deliver the tap");
    expect(down.stderr).not.toContain(NO_SERVER);
  }, 60_000);

  test("after simctl boot, input is acked again well before the 30s not-ready limit", async () => {
    // Don't wait for bootstatus: the not-ready window used to refuse every
    // tap for a full 30s because admit() blocked transmit, so a success
    // could never clear the flag. A non-action probe every 0.5s should
    // clear that flag once the guest can take input. Guest boot itself
    // can exceed 20s on a slow CI runner, so the 20s bound is measured
    // from the first not-ready log, not from `simctl boot`.
    const logAtStart = serverLog.length;
    spawnSync("xcrun", ["simctl", "boot", udid!], { stdio: "ignore" });
    let firstOkAt: number | undefined;
    let notReadyAt: number | undefined;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const r = tap();
      if (notReadyAt == null && serverLog.slice(logAtStart).includes("[hid] Dropping input: HID client is not ready")) {
        notReadyAt = Date.now();
      }
      if (r.status === 0) { firstOkAt = Date.now(); break; }
      expect(r.stderr).not.toContain(NO_SERVER);
      await sleep(400);
    }
    if (firstOkAt == null) throw new Error("no successful tap within 45s of simctl boot");
    if (notReadyAt != null) {
      expect(firstOkAt - notReadyAt).toBeLessThan(20_000);
    }
    expect(server!.exitCode).toBeNull();
  }, 90_000);

  test("after the same simulator boots again, a tap on the guest lands", async () => {
    bootAndWait();
    const r = await tapUntilOk(30_000);
    expect(r.stderr).not.toContain(NO_SERVER);
    expect(r.status).toBe(0);
    expect(server!.exitCode).toBeNull();
    // Without the rebuild the tap above also exits 0 but never reaches the guest.
    const deadline = Date.now() + 5_000;
    while (!serverLog.includes(RECONNECTED) && Date.now() < deadline) await sleep(100);
    expect(serverLog).toContain(RECONNECTED);
    expect(serverLog.split(RECONNECTED).length - 1).toBe(1);

    // Prove the rebuilt client actually delivers: open Settings, tap General,
    // and assert the General screen (About) appears in the AX tree.
    try { execFileSync("xcrun", ["simctl", "terminate", udid!, "com.apple.Preferences"], { stdio: "pipe" }); } catch {}
    execFileSync("xcrun", ["simctl", "launch", udid!, "com.apple.Preferences"], { stdio: "pipe", timeout: 30_000 });

    const axText = (): { status: number | null; stdout: string } => {
      const s = spawnSync("node", [CLI, "ax", "--refs", "--text", "-d", udid!], { encoding: "utf-8", timeout: 15_000 });
      return { status: s.status, stdout: s.stdout ?? "" };
    };

    let snapshot = "";
    const settingsDeadline = Date.now() + 20_000;
    while (Date.now() < settingsDeadline) {
      const s = axText();
      if (s.status === 0 && /"General"/.test(s.stdout)) { snapshot = s.stdout; break; }
      await sleep(500);
    }
    if (!/"General"/.test(snapshot)) throw new Error(`Settings did not show a General row after launch:\n${snapshot}`);
    const generalRef = snapshot.match(/(@e\d+)\s+\S+\s+"General"/)?.[1];
    if (!generalRef) throw new Error(`could not find a General ref in:\n${snapshot}`);
    const tapped = spawnSync("node", [CLI, "tap", generalRef, "-d", udid!], { encoding: "utf-8", timeout: 15_000 });
    expect(tapped.status).toBe(0);
    expect(tapped.stderr).not.toContain(NO_SERVER);

    let after = "";
    const generalDeadline = Date.now() + 15_000;
    while (Date.now() < generalDeadline) {
      const s = axText();
      if (s.status === 0 && /"About"/.test(s.stdout)) { after = s.stdout; break; }
      await sleep(300);
    }
    if (!/"About"/.test(after)) throw new Error(`tapping General should open the General screen (About row):\n${after}`);
  }, 180_000);
});
