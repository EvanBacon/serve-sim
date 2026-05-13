import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Native e2e for `serve-sim type`.
 *
 * Boots through the full stack: textToKeyEvents → WS 0x06 frames →
 * SimStreamHelper.ClientManager → HIDInjector.sendKey → CoreSimulator's HID
 * legacy client. The helper logs `[hid] Key <down|up> usage=0x<hex>` for every
 * accepted key event, which is what we assert against — proving the event
 * round-tripped all the way to the sim, not just to the helper's WS reader.
 *
 * Skipped automatically when no iOS simulator is booted, so this stays green
 * on machines without one. The macOS CI job boots a sim explicitly and runs
 * `bun test packages/serve-sim/src/__tests__/`, so it runs there.
 */

const CLI_PATH = join(import.meta.dir, "../../src/index.ts");
const STATE_DIR = join(tmpdir(), "serve-sim");

function firstBootedIosSim(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const [runtime, devs] of Object.entries(data.devices)) {
      if (!runtime.includes("iOS")) continue;
      for (const d of devs) if (d.state === "Booted") return d.udid;
    }
  } catch {}
  return null;
}

const bootedUdid = firstBootedIosSim();
const describeWithSim = bootedUdid ? describe : describe.skip;

describeWithSim(`serve-sim type e2e (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  let logFile: string;

  beforeAll(() => {
    try { execSync(`bun run ${CLI_PATH} --kill`, { stdio: "pipe" }); } catch {}

    const detach = spawnSync("bun", ["run", CLI_PATH, "--detach", bootedUdid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 45_000,
    });
    if (detach.status !== 0 || !detach.stdout) {
      throw new Error(
        `serve-sim --detach failed (exit=${detach.status} signal=${detach.signal})\nstdout: ${detach.stdout}`,
      );
    }
    logFile = join(STATE_DIR, `server-${bootedUdid!}.log`);
  }, 60_000);

  afterAll(() => {
    try { execSync(`bun run ${CLI_PATH} --kill`, { stdio: "pipe" }); } catch {}
  });

  test("`serve-sim type` injects HID key events into the booted simulator", async () => {
    const logBefore = readFileSync(logFile, "utf-8");
    const beforeCount = countKeyLines(logBefore);

    // "Hi!" → 10 events:
    //   H: shift down, KeyH down, KeyH up, shift up      (0xe1, 0x0b, 0x0b, 0xe1)
    //   i: KeyI down, KeyI up                            (0x0c, 0x0c)
    //   !: shift down, Digit1 down, Digit1 up, shift up  (0xe1, 0x1e, 0x1e, 0xe1)
    const result = spawnSync("bun", ["run", CLI_PATH, "type", "Hi!", "-d", bootedUdid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    expect(result.status).toBe(0);

    // Wait briefly for the helper to flush its stdout log — sendKey is sync,
    // but stdio buffering means a few ms can elapse before lines hit the file.
    await new Promise((r) => setTimeout(r, 200));

    const logAfter = readFileSync(logFile, "utf-8");
    const newLines = logAfter.slice(logBefore.length);
    const afterCount = countKeyLines(logAfter);

    expect(afterCount - beforeCount).toBe(10);

    // Every usage we sent must show up at least once in the new log slice.
    const expectedUsages = [0xe1, 0x0b, 0x0c, 0x1e];
    for (const usage of expectedUsages) {
      const hex = usage.toString(16);
      expect(newLines).toContain(`usage=0x${hex}`);
    }

    // And we should see balanced down/up events for the new slice.
    expect(countMatches(newLines, /\[hid\] Key down /g)).toBe(5);
    expect(countMatches(newLines, /\[hid\] Key up /g)).toBe(5);
  }, 30_000);
});

function countKeyLines(s: string): number {
  return countMatches(s, /\[hid\] Key (down|up) /g);
}

function countMatches(s: string, re: RegExp): number {
  let n = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) n++;
  return n;
}
