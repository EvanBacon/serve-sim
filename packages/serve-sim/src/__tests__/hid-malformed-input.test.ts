import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/**
 * Regression test for the in-process HID path (napi migration, #108).
 *
 * HID injection used to run in a spawned `serve-sim-bin` helper, so a malformed
 * input message could at worst crash that helper. Now HID runs in-process: the
 * N-API binding throws synchronously when a JS value can't be coerced to its
 * native parameter type (e.g. a touch whose `type` is missing →
 * "Could not convert parameter 0 to type String"), and an unhandled throw takes
 * down the WHOLE server — killing the live stream and, if it lands mid-gesture,
 * leaving the guest with a stuck finger that wedges all touch until reboot.
 *
 * `NativeHid` now guards every native call, so a bad frame is ignored instead of
 * fatal. This test sends a malformed touch frame (tag 0x03, JSON with no `type`)
 * straight down the real `/ws` HID protocol and asserts the server is still
 * serving afterward — and that it still accepts a well-formed touch.
 */

// Drives the built CLI (dist/serve-sim.js) so the test exercises the shipped
// artifact — the same one CI builds before this directory runs.
const CLI = join(import.meta.dir, "../../dist/serve-sim.js");

const WS_TAG_TOUCH = 0x03;

function firstBootedIosSim(): string | null {
  try {
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!/iOS/i.test(runtime)) continue;
      for (const d of devices) if (d.state === "Booted") return d.udid;
    }
  } catch {}
  return null;
}

/** Open `/ws`, send one `[tag][JSON]` frame, then close. Resolves on close. */
function sendHidFrame(wsUrl: string, tag: number, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      const json = new TextEncoder().encode(JSON.stringify(payload));
      const msg = new Uint8Array(1 + json.length);
      msg[0] = tag;
      msg.set(json, 1);
      ws.send(msg);
      setTimeout(() => { ws.close(); resolve(); }, 50);
    };
    ws.onerror = () => reject(new Error(`failed to connect ${wsUrl}`));
  });
}

const bootedUdid = firstBootedIosSim();
// Needs a booted iOS sim and the built CLI; CI builds serve-sim first.
const describeIfSim = bootedUdid && existsSync(CLI) ? describe : describe.skip;

describeIfSim(`serve-sim malformed HID input (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  let wsUrl: string;
  let configUrl: string;

  beforeAll(async () => {
    try { execFileSync("node", [CLI, "--kill", bootedUdid!], { stdio: "pipe" }); } catch {}

    const startPort = 40_000 + Math.floor(Math.random() * 20_000);
    const detach = spawnSync("node", [CLI, "--detach", "-p", String(startPort), bootedUdid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 45_000,
    });
    if (detach.status !== 0 || !detach.stdout) {
      throw new Error(
        `serve-sim --detach failed (exit=${detach.status} signal=${detach.signal})\n` +
        `stdout: ${detach.stdout ?? "<none>"}`,
      );
    }
    const state = JSON.parse(detach.stdout.trim()) as { wsUrl: string; streamUrl: string };
    wsUrl = state.wsUrl;
    configUrl = state.streamUrl.replace("stream.mjpeg", "config");

    // `--detach` returns once the child is spawned, but on a cold CI runner the
    // server may not be listening yet. Poll /config until it answers so the
    // test's "still alive" checks measure crashes, not a slow cold start.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(configUrl)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
  }, 60_000);

  afterAll(() => {
    try { execFileSync("node", [CLI, "--kill", bootedUdid!], { stdio: "pipe" }); } catch {}
  }, 30_000);

  async function serverAlive(): Promise<boolean> {
    try {
      return (await fetch(configUrl)).ok;
    } catch {
      return false;
    }
  }

  test("a malformed touch frame does not crash the server", async () => {
    expect(await serverAlive()).toBe(true);

    // `{x, y}` with no `type` → the native touch() binding throws on the
    // non-string first parameter. Pre-fix this propagated and killed the server.
    await sendHidFrame(wsUrl, WS_TAG_TOUCH, { x: 0.5, y: 0.5 });

    // Give an uncaught-exception crash time to take the process down.
    await new Promise((r) => setTimeout(r, 750));
    expect(await serverAlive()).toBe(true);

    // The server still accepts a well-formed touch after the bad frame.
    await sendHidFrame(wsUrl, WS_TAG_TOUCH, { type: "begin", x: 0.5, y: 0.5 });
    await sendHidFrame(wsUrl, WS_TAG_TOUCH, { type: "end", x: 0.5, y: 0.5 });
    await new Promise((r) => setTimeout(r, 250));
    expect(await serverAlive()).toBe(true);
  }, 30_000);
});
