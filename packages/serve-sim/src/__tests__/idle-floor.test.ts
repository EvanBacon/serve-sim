import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Integration test for the idle-frame-floor guarantee.
 *
 * Regression target: once upon a time, captureFrame()'s seed-skip would
 * silence the stream entirely on a static simulator, which left browser
 * <img src=stream.mjpeg> tags blank and any upstream relay's cachedFrame
 * null, so the first remote subscriber hung on "Connecting…". This test
 * starts serve-sim against a real booted sim and asserts that:
 *
 *   1. The first JPEG frame arrives within 1s of stream.mjpeg being opened.
 *   2. At least 3 frame boundaries show up within 2s on an idle simulator
 *      — i.e. the ~5 fps idle floor is live.
 *   3. Every parsed JPEG starts with the SOI magic bytes 0xFFD8.
 *
 * Skipped automatically if no iOS simulator is currently booted, so the
 * suite stays green on machines/CI jobs without a booted sim. When the
 * publish-serve-sim CI job boots one explicitly, the test runs there.
 */

const CLI_PATH = join(import.meta.dir, "../../src/index.ts");
// CI macOS simulators are markedly slower than dev laptops at producing the
// first framebuffer snapshot, so budgets here are sized for the slow runner —
// the regression we're guarding against (silenced stream → blank img tags) is
// a complete absence of frames, not a few hundred ms of latency.
const FIRST_FRAME_BUDGET_MS = process.env.CI ? 5000 : 1500;
const IDLE_WINDOW_MS = process.env.CI ? 5000 : 2000;
const MIN_FRAMES_IN_IDLE_WINDOW = 3;

function firstBootedIosSim(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string; name?: string }>>;
    };
    for (const [runtime, devs] of Object.entries(data.devices)) {
      // Only iOS simulators — watchOS/tvOS have different framebuffer shapes
      // and aren't what the production code targets.
      if (!runtime.includes("iOS")) continue;
      for (const d of devs) {
        if (d.state === "Booted") return d.udid;
      }
    }
  } catch {}
  return null;
}

const bootedUdid = firstBootedIosSim();
const describeWithSim = bootedUdid ? describe : describe.skip;

// ── Multipart parser (standalone copy to keep this package self-contained). ──
interface ParsedFrame {
  jpeg: Buffer;
}

function parseMjpegStream(buf: Buffer): { frames: ParsedFrame[]; rest: Buffer } {
  const BOUNDARY = Buffer.from("--frame");
  const HEADER_END = Buffer.from("\r\n\r\n");
  const frames: ParsedFrame[] = [];
  let cursor = buf;

  while (true) {
    const boundaryIdx = cursor.indexOf(BOUNDARY);
    if (boundaryIdx === -1) break;
    const headerEndIdx = cursor.indexOf(HEADER_END, boundaryIdx);
    if (headerEndIdx === -1) break;

    const headerStr = cursor.toString("utf8", boundaryIdx, headerEndIdx);
    const clMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) {
      cursor = cursor.subarray(headerEndIdx + HEADER_END.length);
      continue;
    }
    const contentLength = parseInt(clMatch[1]!, 10);
    const frameStart = headerEndIdx + HEADER_END.length;
    if (cursor.length < frameStart + contentLength) break;

    const jpeg = cursor.subarray(frameStart, frameStart + contentLength);
    frames.push({ jpeg: Buffer.from(jpeg) });

    let nextStart = frameStart + contentLength;
    if (
      nextStart + 1 < cursor.length &&
      cursor[nextStart] === 0x0d &&
      cursor[nextStart + 1] === 0x0a
    ) {
      nextStart += 2;
    }
    cursor = cursor.subarray(nextStart);
  }

  return { frames, rest: Buffer.from(cursor) };
}

/** Dump every serve-sim helper log file so CI failures are self-explanatory. */
function dumpHelperLogs(): string {
  const stateDir = join(tmpdir(), "serve-sim");
  const out: string[] = [];
  try {
    for (const f of readdirSync(stateDir)) {
      if (!f.startsWith("server-") || !f.endsWith(".log")) continue;
      try {
        const content = readFileSync(join(stateDir, f), "utf-8");
        out.push(`── ${f} ──\n${content}`);
      } catch {}
    }
  } catch {}
  return out.join("\n\n");
}

describeWithSim(`serve-sim idle frame floor (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  let streamUrl: string;

  beforeAll(() => {
    // Try kill any prior state — best effort.
    try { execSync(`bun run ${CLI_PATH} --kill`, { stdio: "pipe" }); } catch {}

    // stderr is inherited so any diagnostic from serve-sim or the Swift helper
    // lands directly in the test output — critical when the subprocess hangs
    // under CI and we need to know *where*. stdout stays captured so we can
    // still parse the JSON state blob.
    const detach = spawnSync("bun", ["run", CLI_PATH, "--detach", bootedUdid!], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 45_000,
    });
    if (detach.status !== 0 || !detach.stdout) {
      const helperLogs = dumpHelperLogs();
      throw new Error(
        `serve-sim --detach failed (exit=${detach.status} signal=${detach.signal})\n` +
        `stdout: ${detach.stdout ?? "<none>"}\n` +
        `helper logs:\n${helperLogs || "<none>"}`,
      );
    }
    try {
      const info = JSON.parse(detach.stdout.trim()) as { streamUrl: string };
      streamUrl = info.streamUrl;
    } catch (err) {
      throw new Error(
        `serve-sim --detach returned unparseable stdout: ${detach.stdout}\n` +
        `helper logs:\n${dumpHelperLogs()}`,
      );
    }
  }, 60_000);

  afterAll(() => {
    try { execSync(`bun run ${CLI_PATH} --kill`, { stdio: "pipe" }); } catch {}
  });

  test("first frame arrives quickly even on an idle simulator", async () => {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FIRST_FRAME_BUDGET_MS + 500);

    const res = await fetch(streamUrl, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("multipart/x-mixed-replace");

    const reader = res.body!.getReader();
    let buf = Buffer.alloc(0);
    let firstFrameAt: number | null = null;

    try {
      while (Date.now() - t0 < FIRST_FRAME_BUDGET_MS) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = Buffer.concat([buf, Buffer.from(value)]);
        const parsed = parseMjpegStream(buf);
        buf = parsed.rest;
        if (parsed.frames.length > 0) {
          firstFrameAt = Date.now() - t0;
          // Sanity: every frame must start with JPEG SOI.
          for (const f of parsed.frames) {
            expect(f.jpeg[0]).toBe(0xff);
            expect(f.jpeg[1]).toBe(0xd8);
          }
          break;
        }
      }
    } catch (err) {
      // AbortError from the budget timer is expected when the stream stalls;
      // fall through so the assertion below reports the real diagnosis
      // (firstFrameAt === null) instead of a confusing unhandled rejection.
      if ((err as { name?: string }).name !== "AbortError") throw err;
    }

    clearTimeout(timer);
    try { reader.cancel(); } catch {}

    expect(firstFrameAt).not.toBeNull();
    expect(firstFrameAt).toBeLessThanOrEqual(FIRST_FRAME_BUDGET_MS);
  }, FIRST_FRAME_BUDGET_MS + 5000);

  test(`idle floor emits >= ${MIN_FRAMES_IN_IDLE_WINDOW} frames in ${IDLE_WINDOW_MS}ms`, async () => {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IDLE_WINDOW_MS + 500);

    const res = await fetch(streamUrl, { signal: controller.signal });
    const reader = res.body!.getReader();

    let buf = Buffer.alloc(0);
    let frameCount = 0;
    const sizes: number[] = [];

    try {
      while (Date.now() - t0 < IDLE_WINDOW_MS) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = Buffer.concat([buf, Buffer.from(value)]);
        const parsed = parseMjpegStream(buf);
        buf = parsed.rest;
        for (const f of parsed.frames) {
          frameCount++;
          sizes.push(f.jpeg.length);
          expect(f.jpeg[0]).toBe(0xff);
          expect(f.jpeg[1]).toBe(0xd8);
        }
      }
    } catch (err) {
      // The abort-controller deadline is supposed to fire at the end of the
      // window — let the frame-count assertion be the actual signal.
      if ((err as { name?: string }).name !== "AbortError") throw err;
    }

    clearTimeout(timer);
    try { reader.cancel(); } catch {}

    expect(frameCount).toBeGreaterThanOrEqual(MIN_FRAMES_IN_IDLE_WINDOW);
    // Every frame should have a reasonable size — serve-sim emits a real
    // JPEG, not an empty buffer.
    for (const s of sizes) expect(s).toBeGreaterThan(1000);
  }, IDLE_WINDOW_MS + 5000);
});
