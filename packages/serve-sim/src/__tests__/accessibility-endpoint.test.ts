import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { join } from "path";

/**
 * Integration test for the accessibility endpoint.
 *
 * Skipped automatically when no iOS simulator is booted. On machines with a
 * booted sim, this exercises the Swift helper's /ax path end-to-end so deep or
 * cyclic AX trees fail as endpoint crashes/timeouts instead of slipping by as
 * compile-only changes.
 */

const CLI_PATH = join(import.meta.dir, "../../src/index.ts");
const AX_RESPONSE_BUDGET_MS = process.env.CI ? 10_000 : 5_000;

function firstBootedIosSim(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string; name?: string }>>;
    };
    for (const [runtime, devices] of Object.entries(data.devices)) {
      if (!runtime.includes("iOS")) continue;
      for (const device of devices) {
        if (device.state === "Booted") return device.udid;
      }
    }
  } catch {}
  return null;
}

const bootedUdid = firstBootedIosSim();
const describeWithSim = bootedUdid ? describe : describe.skip;

describeWithSim(`serve-sim accessibility endpoint (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  let axUrl: string;

  beforeAll(() => {
    try { execSync(`bun run ${CLI_PATH} --kill ${bootedUdid}`, { stdio: "pipe" }); } catch {}

    // Random high port avoids collisions with the user's running serve-sim
    // (default 3100) and with concurrent test runs on the same machine. The
    // CLI's findAvailablePort scans up from this if it's taken.
    const startPort = 40_000 + Math.floor(Math.random() * 20_000);
    const detach = spawnSync("bun", ["run", CLI_PATH, "--detach", "-p", String(startPort), bootedUdid!], {
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

    const state = JSON.parse(detach.stdout.trim()) as { url: string };
    axUrl = `${state.url}/ax`;
  }, 60_000);

  afterAll(() => {
    try { execSync(`bun run ${CLI_PATH} --kill ${bootedUdid}`, { stdio: "pipe" }); } catch {}
  });

  test("returns a bounded accessibility tree without crashing the helper", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AX_RESPONSE_BUDGET_MS);

    try {
      const res = await fetch(axUrl, { signal: controller.signal });
      expect(res.status).toBe(200);
      const tree = await res.json() as Array<{ frame?: unknown; type?: string }>;
      expect(Array.isArray(tree)).toBe(true);
      expect(tree.length).toBeGreaterThan(0);
      expect(tree[0]?.frame).toBeTruthy();
      expect(typeof tree[0]?.type).toBe("string");
    } finally {
      clearTimeout(timer);
    }
  }, AX_RESPONSE_BUDGET_MS + 5_000);
});
