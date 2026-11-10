// `serve-sim record frame|diff|changes` against a real (tiny, generated) MP4
// decoded by the native addon. The MP4 is written at test time by
// fixtures/make-test-video.swift; nothing binary lives in the repo.
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readVideoFrame, readVideoInfo } from "../native";
import { runRecordInspect, type RecordInspectDeps } from "../record-inspect";

const PKG = join(import.meta.dir, "../..");
const ADDON = join(PKG, "dist/native/serve-sim-native.node");
const GENERATOR = join(import.meta.dir, "fixtures/make-test-video.swift");
const hasSwiftc = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;
const shouldRun = hasSwiftc && existsSync(ADDON);

const W = 128;
const H = 96;
const FPS = 10;
const RED = [255, 0, 0];
const RECT = [32, 24, 40, 30];
// Frames 0-4 solid red; 5-9 red with a blue rectangle.
const SPEC = Array.from({ length: 10 }, (_, i) => (i < 5 ? { bg: RED } : { bg: RED, rect: [...RECT, 0, 0, 255] }));

let dir = "";
let mp4 = "";

beforeAll(() => {
  if (!shouldRun) return;
  dir = mkdtempSync(join(tmpdir(), "record-inspect-it-"));
  const bin = join(dir, "make-test-video");
  const build = spawnSync("xcrun", ["swiftc", "-O", "-o", bin, GENERATOR], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(`swiftc failed:\n${build.stderr}`);
  writeFileSync(join(dir, "spec.json"), JSON.stringify(SPEC));
  mp4 = join(dir, "synthetic.mp4");
  const make = spawnSync(bin, [mp4, String(W), String(H), String(FPS), join(dir, "spec.json")], { encoding: "utf8" });
  if (make.status !== 0) throw new Error(`make-test-video failed:\n${make.stderr}`);
}, 60_000);

function deps() {
  const out: string[] = [];
  const err: string[] = [];
  const d: RecordInspectDeps = {
    videoInfo: readVideoInfo,
    videoFrame: readVideoFrame,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    writeStdout: () => { throw new Error("unexpected stdout write"); },
    stdoutIsTTY: false,
  };
  return { d, out, err };
}

function pngSize(path: string): { width: number; height: number } {
  const png = readFileSync(path);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe.skipIf(!shouldRun)("record inspect (native decode)", () => {
  test("videoInfo lists every sample on the presentation timeline", async () => {
    const info = await readVideoInfo(mp4);
    expect(info.width).toBe(W);
    expect(info.height).toBe(H);
    expect(info.duration).toBeCloseTo(1, 6);
    expect(info.sampleTimes.map((t) => Math.round(t * 1e6) / 1e6)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  });

  test("frame at t=0 and mid-video are valid PNGs with the right content", async () => {
    const { d, out } = deps();
    const first = join(dir, "first.png");
    expect(await runRecordInspect({ verb: "frame", mp4, t: 0, output: first }, d)).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ i: 0, pts: 0, path: first, width: W, height: H });
    expect(pngSize(first)).toEqual({ width: W, height: H });

    expect(await runRecordInspect({ verb: "frame", mp4, t: 0.52 }, d)).toBe(0);
    const mid = JSON.parse(out[1]!);
    expect(mid).toMatchObject({ i: 5, pts: 0.5, path: join(dir, "synthetic-t0.52.png") });
    expect(pngSize(mid.path)).toEqual({ width: W, height: H });

    // The decoded pixels: red outside the rectangle, blue inside it.
    const frame = await readVideoFrame(mp4, 0.5);
    const at = (x: number, y: number) => [...frame.rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
    const [r1, , b1] = at(5, 5);
    expect(r1!).toBeGreaterThan(200);
    expect(b1!).toBeLessThan(60);
    const [r2, , b2] = at(50, 40);
    expect(r2!).toBeLessThan(60);
    expect(b2!).toBeGreaterThan(200);
  });

  test("out-of-range t is a clear error", async () => {
    const { d, err } = deps();
    expect(await runRecordInspect({ verb: "frame", mp4, t: 5 }, d)).toBe(1);
    expect(err[0]).toMatch(/-t 5 is outside the recording \(0–1 s\)/);
  });

  test("diff of different frames: changedPixels > 0 and a bbox around the rectangle", async () => {
    const { d, out } = deps();
    expect(await runRecordInspect({ verb: "diff", mp4, from: 0.2, to: 0.7 }, d)).toBe(0);
    const result = JSON.parse(out[0]!);
    expect(result.from).toEqual({ i: 2, pts: 0.2 });
    expect(result.to).toEqual({ i: 7, pts: 0.7 });
    expect(result.changedPixels).toBeGreaterThan(RECT[2]! * RECT[3]! * 0.8);
    // Chroma subsampling can bleed an edge pixel or two.
    const [x, y, w, h] = RECT as [number, number, number, number];
    expect(Math.abs(result.bbox.x - x)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.bbox.y - y)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.bbox.w - w)).toBeLessThanOrEqual(4);
    expect(Math.abs(result.bbox.h - h)).toBeLessThanOrEqual(4);
    expect(pngSize(result.path)).toEqual({ width: W, height: H });
  });

  test("diff of identical frames: 0 changed pixels, null bbox", async () => {
    const { d, out } = deps();
    expect(await runRecordInspect({ verb: "diff", mp4, from: 0.1, to: 0.3, output: join(dir, "same.png") }, d)).toBe(0);
    const result = JSON.parse(out[0]!);
    expect(result.changedPixels).toBe(0);
    expect(result.bbox).toBeNull();
  });

  test("the CLI routes `record frame|changes` past record's own -o/-t", () => {
    const cli = (args: string[]) => spawnSync("bun", [join(PKG, "src/index.ts"), "record", ...args], { encoding: "utf8" });
    const output = join(dir, "cli.png");
    const frame = cli(["frame", mp4, "-t", "0.7", "-o", output]);
    expect(frame.status).toBe(0);
    expect(JSON.parse(frame.stdout)).toEqual({ i: 7, pts: 0.7, path: output, width: W, height: H });
    expect(existsSync(output)).toBe(true);

    const changes = cli(["changes", mp4]);
    expect(changes.status).toBe(1);
    expect(changes.stderr).toMatch(/re-record without --no-index/);

    const help = cli(["diff", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage: serve-sim record diff");
  }, 30_000);
});
