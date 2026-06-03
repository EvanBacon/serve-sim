import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync, spawnSync } from "child_process";
import { join } from "path";

/**
 * Integration test for the AVCC (H.264) stream endpoint.
 *
 * Skipped automatically when no iOS simulator is booted. On a booted sim it
 * exercises the Swift helper's /stream.avcc path end-to-end: connect, then
 * verify the length-prefixed AVCC envelope carries a decoder description
 * (SPS/PPS) and at least one keyframe — i.e. VideoToolbox actually produced a
 * decodable H.264 stream rather than the endpoint silently emitting nothing.
 */

const CLI_PATH = join(import.meta.dir, "../../src/index.ts");
const STREAM_BUDGET_MS = process.env.CI ? 30_000 : 12_000;

// Envelope tags — kept in sync with Swift AVCCEnvelope / TS avcc-codec.
const TAG_DESCRIPTION = 0x01;
const TAG_KEYFRAME = 0x02;
const TAG_DELTA = 0x03;
const TAG_SEED = 0x04;

function firstBootedIosSim(): string | null {
  try {
    const out = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
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

/** Parse a length-prefixed AVCC byte stream into {tag} chunks. */
function* parseEnvelope(buffer: Uint8Array): Generator<number> {
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 4);
    const length = view.getUint32(0, false);
    if (buffer.length - offset - 4 < length || length < 1) break;
    yield buffer[offset + 4]!;
    offset += 4 + length;
  }
}

const bootedUdid = firstBootedIosSim();
const describeWithSim = bootedUdid ? describe : describe.skip;

describeWithSim(`serve-sim AVCC endpoint (booted sim ${bootedUdid ?? "<skipped>"})`, () => {
  let avccUrl: string;

  beforeAll(() => {
    try { execSync(`bun run ${CLI_PATH} --kill ${bootedUdid}`, { stdio: "pipe" }); } catch {}

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
    avccUrl = `${state.url}/stream.avcc`;
  }, 60_000);

  afterAll(() => {
    try { execSync(`bun run ${CLI_PATH} --kill ${bootedUdid}`, { stdio: "pipe" }); } catch {}
  });

  test("emits a decoder description and a keyframe", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STREAM_BUDGET_MS);

    const seenTags = new Set<number>();
    let buffer = new Uint8Array(0);

    try {
      const res = await fetch(avccUrl, { signal: controller.signal });
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      expect(reader).toBeTruthy();

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const merged = new Uint8Array(buffer.length + value.length);
          merged.set(buffer);
          merged.set(value, buffer.length);
          buffer = merged;
          for (const tag of parseEnvelope(buffer)) seenTags.add(tag);
          // Stop as soon as we've proven a decodable stream: config + an IDR.
          if (seenTags.has(TAG_DESCRIPTION) && seenTags.has(TAG_KEYFRAME)) break;
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") throw e;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }

    // A valid stream must include the avcC description and at least one IDR.
    expect(seenTags.has(TAG_DESCRIPTION)).toBe(true);
    expect(seenTags.has(TAG_KEYFRAME)).toBe(true);
    // Tags must all be known envelope kinds (no framing corruption).
    for (const tag of seenTags) {
      expect([TAG_DESCRIPTION, TAG_KEYFRAME, TAG_DELTA, TAG_SEED]).toContain(tag);
    }
  }, STREAM_BUDGET_MS + 5_000);
});
