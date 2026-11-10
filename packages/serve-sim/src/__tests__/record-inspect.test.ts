import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  defaultDiffOutput,
  defaultFrameOutput,
  parseInspectTime,
  parseRecordInspectArgs,
  recordInspectArgv,
  runRecordInspect,
  type RecordInspectDeps,
} from "../record-inspect";
import { recordingIndexPath } from "../recording-index";

describe("parseInspectTime", () => {
  test("seconds, s and ms suffixes", () => {
    expect(parseInspectTime("1.5")).toBe(1.5);
    expect(parseInspectTime("0")).toBe(0);
    expect(parseInspectTime("2s")).toBe(2);
    expect(parseInspectTime("250ms")).toBe(0.25);
    expect(parseInspectTime(".5")).toBe(0.5);
  });

  test("rejects negatives and junk", () => {
    expect(parseInspectTime("-1")).toBeNull();
    expect(parseInspectTime("abc")).toBeNull();
    expect(parseInspectTime("")).toBeNull();
    expect(parseInspectTime("1m")).toBeNull();
  });
});

describe("recordInspectArgv", () => {
  test("everything after `record <verb>`, whatever commander made of it", () => {
    expect(recordInspectArgv(["node", "serve-sim.js", "record", "frame", "a.mp4", "-t", "1", "-o", "x.png"], "frame"))
      .toEqual(["a.mp4", "-t", "1", "-o", "x.png"]);
    expect(recordInspectArgv(["bun", "x", "record", "-d", "u", "diff", "a.mp4", "--from", "1"], "diff"))
      .toEqual(["a.mp4", "--from", "1"]);
    // A file named like the verb is still the argument.
    expect(recordInspectArgv(["n", "s", "record", "frame", "frame", "-t", "0"], "frame")).toEqual(["frame", "-t", "0"]);
  });
});

describe("parseRecordInspectArgs", () => {
  test("frame: mp4, -t, -o, --index (and --flag=value)", () => {
    expect(parseRecordInspectArgs("frame", ["rec.mp4", "-t", "1.5"])).toEqual({ verb: "frame", mp4: "rec.mp4", t: 1.5 });
    expect(parseRecordInspectArgs("frame", ["-t", "2", "rec.mp4", "-o", "out.png", "--index=side.jsonl"]))
      .toEqual({ verb: "frame", mp4: "rec.mp4", t: 2, output: "out.png", index: "side.jsonl" });
    expect(parseRecordInspectArgs("frame", ["rec.mp4", "--time", "500ms", "--output", "-"]))
      .toEqual({ verb: "frame", mp4: "rec.mp4", t: 0.5, output: "-" });
  });

  test("frame: -t is required and validated", () => {
    expect(() => parseRecordInspectArgs("frame", ["rec.mp4"])).toThrow(/-t <seconds> is required/);
    expect(() => parseRecordInspectArgs("frame", ["rec.mp4", "-t", "soon"])).toThrow(/-t: expected seconds/);
    expect(() => parseRecordInspectArgs("frame", ["rec.mp4", "-t"])).toThrow(/-t needs a value/);
  });

  test("diff: --from and --to required, --threshold optional", () => {
    expect(parseRecordInspectArgs("diff", ["rec.mp4", "--from", "1", "--to", "2.5"]))
      .toEqual({ verb: "diff", mp4: "rec.mp4", from: 1, to: 2.5 });
    expect(parseRecordInspectArgs("diff", ["rec.mp4", "--from", "1", "--to", "2", "--threshold", "8", "-o", "d.png"]))
      .toEqual({ verb: "diff", mp4: "rec.mp4", from: 1, to: 2, threshold: 8, output: "d.png" });
    expect(() => parseRecordInspectArgs("diff", ["rec.mp4", "--from", "1"])).toThrow(/--to <seconds> is required/);
    expect(() => parseRecordInspectArgs("diff", ["rec.mp4", "--from", "1", "--to", "2", "--threshold", "300"])).toThrow(/--threshold/);
  });

  test("changes: window and --near optional, no -o", () => {
    expect(parseRecordInspectArgs("changes", ["rec.mp4"])).toEqual({ verb: "changes", mp4: "rec.mp4" });
    expect(parseRecordInspectArgs("changes", ["rec.mp4", "--from", "1", "--to", "3", "--near", "0.25", "--index", "i.jsonl"]))
      .toEqual({ verb: "changes", mp4: "rec.mp4", from: 1, to: 3, near: 0.25, index: "i.jsonl" });
    expect(() => parseRecordInspectArgs("changes", ["rec.mp4", "-o", "x"])).toThrow(/unknown option -o/);
  });

  test("errors: missing mp4, extra positional, unknown option", () => {
    expect(() => parseRecordInspectArgs("frame", ["-t", "1"])).toThrow(/<mp4> is required/);
    expect(() => parseRecordInspectArgs("frame", ["a.mp4", "b.mp4", "-t", "1"])).toThrow(/unexpected argument b\.mp4/);
    expect(() => parseRecordInspectArgs("frame", ["a.mp4", "-t", "1", "--bogus"])).toThrow(/unknown option --bogus/);
  });

  test("-h / --help", () => {
    expect(parseRecordInspectArgs("diff", ["--help"])).toEqual({ verb: "diff", help: true });
    expect(parseRecordInspectArgs("frame", ["a.mp4", "-h"])).toEqual({ verb: "frame", help: true });
    // As an option's value it's just a value.
    expect(parseRecordInspectArgs("frame", ["a.mp4", "-t", "1", "-o", "-h"])).toEqual({ verb: "frame", mp4: "a.mp4", t: 1, output: "-h" });
  });
});

describe("default output paths", () => {
  test("next to the MP4, named by stem and time", () => {
    expect(defaultFrameOutput("/r/rec.mp4", 1.5)).toBe("/r/rec-t1.5.png");
    expect(defaultFrameOutput("/r/rec.MP4", 0)).toBe("/r/rec-t0.png");
    expect(defaultFrameOutput("/r/a.b.mov", 1 / 3)).toBe("/r/a.b-t0.333.png");
    expect(defaultFrameOutput("rec.mp4", 2)).toBe("rec-t2.png");
    expect(defaultDiffOutput("/r/rec.mp4", 1, 2.25)).toBe("/r/rec-diff-1-2.25.png");
  });
});

// ─── runner, with the native reads faked ───────────────────────────────────

const W = 4;
const H = 2;
/**
 * Fake video: 10 fps, 6 samples; samples 3-5 are gray 120 (others black),
 * sample 4 has one white pixel. Like AVFoundation at zero tolerance, a
 * request decodes the sample whose window [k/10, (k+1)/10) holds it.
 */
function fakeDeps(dir: string, overrides: Partial<RecordInspectDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const stdoutBytes: Uint8Array[] = [];
  const decoded: number[] = [];
  const deps: RecordInspectDeps = {
    videoInfo: async () => ({ duration: 0.6, width: W, height: H, sampleTimes: [0, 0.1, 0.2, 0.3, 0.4, 0.5] }),
    videoFrame: async (_path, seconds) => {
      decoded.push(seconds);
      const k = Math.min(5, Math.floor(seconds * 10 + 1e-9));
      const rgba = new Uint8Array(W * H * 4).fill(k === 5 ? 120 : k >= 3 ? 120 : 0);
      for (let p = 3; p < rgba.length; p += 4) rgba[p] = 255;
      if (k === 4) rgba.set([255, 255, 255, 255], (1 * W + 2) * 4);
      return { width: W, height: H, time: k / 10, rgba };
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    writeStdout: (bytes) => stdoutBytes.push(bytes),
    stdoutIsTTY: false,
    ...overrides,
  };
  const mp4 = join(dir, "rec.mp4");
  writeFileSync(mp4, "not really an mp4");
  return { deps, out, err, stdoutBytes, decoded, mp4 };
}

function writeSidecar(mp4: string) {
  const lines = [
    { type: "header", version: 1, file: "rec.mp4", fps: 10, clock: null },
    ...[0, 1, 2, 3, 4, 5].map((i) => ({ type: "frame", i, pts: i / 10, uptime: i, changed: i === 0 || i === 3 || i === 4 })),
    { type: "event", t: 0.25, id: 7, timestamp: "x", kind: "tap", summary: "Tap", x: 0.5, y: 0.5 },
    { type: "footer", frames: 6, changedFrames: 3, durationSec: 0.6, events: 1, eventsDropped: 0, truncated: false },
  ];
  writeFileSync(recordingIndexPath(mp4), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const tmp = () => mkdtempSync(join(tmpdir(), "rec-inspect-"));

describe("runRecordInspect frame", () => {
  test("no sidecar: picks the nearest sample from the video, writes the default PNG", async () => {
    const { deps, out, decoded, mp4 } = fakeDeps(tmp());
    expect(await runRecordInspect({ verb: "frame", mp4, t: 0.32 }, deps)).toBe(0);
    const path = join(mp4, "..", "rec-t0.32.png");
    // The middle of the sample, so rounding can't land in the previous one.
    expect(decoded.map((s) => Math.round(s * 1e6) / 1e6)).toEqual([0.35]);
    expect(JSON.parse(out[0]!)).toEqual({ i: 3, pts: 0.3, decodedPts: 0.3, path, width: W, height: H });
    expect([...readFileSync(path).subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
  });

  test("with the sidecar: uses its pts and reports changed", async () => {
    const { deps, out, mp4 } = fakeDeps(tmp(), { videoInfo: async () => { throw new Error("should not scan the video"); } });
    writeSidecar(mp4);
    const output = join(mp4, "..", "custom.png");
    expect(await runRecordInspect({ verb: "frame", mp4, t: 0.41, output }, deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ i: 4, pts: 0.4, decodedPts: 0.4, changed: true, path: output, width: W, height: H });
    expect(existsSync(output)).toBe(true);
  });

  test("a truncated sidecar falls back to the MP4's sample times (changed where covered)", async () => {
    const { deps, out, mp4 } = fakeDeps(tmp());
    const lines = [
      { type: "header", version: 1, fps: 10, clock: null },
      { type: "frame", i: 0, pts: 0, uptime: 0, changed: true },
      { type: "frame", i: 1, pts: 0.1, uptime: 0, changed: true },
      { type: "footer", frames: 2, changedFrames: 2, durationSec: 0.6, events: 0, eventsDropped: 0, truncated: true },
    ];
    writeFileSync(recordingIndexPath(mp4), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(await runRecordInspect({ verb: "frame", mp4, t: 0.5, output: join(tmp(), "a.png") }, deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ i: 5, pts: 0.5 });
    expect(JSON.parse(out[0]!).changed).toBeUndefined();
    expect(await runRecordInspect({ verb: "frame", mp4, t: 0.1, output: join(tmp(), "b.png") }, deps)).toBe(0);
    expect(JSON.parse(out[1]!)).toMatchObject({ i: 1, pts: 0.1, changed: true });
  });

  test("out-of-range t is a clear error", async () => {
    const { deps, err, mp4 } = fakeDeps(tmp());
    expect(await runRecordInspect({ verb: "frame", mp4, t: 9 }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/-t 9 is outside the recording \(0–0\.6 s\)/);
  });

  test("-o - writes the PNG to stdout (JSON to stderr) but refuses a terminal", async () => {
    const piped = fakeDeps(tmp());
    expect(await runRecordInspect({ verb: "frame", mp4: piped.mp4, t: 0, output: "-" }, piped.deps)).toBe(0);
    expect(piped.stdoutBytes).toHaveLength(1);
    expect(piped.out).toEqual([]);
    expect(JSON.parse(piped.err[0]!).path).toBe("-");

    const tty = fakeDeps(tmp(), { stdoutIsTTY: true });
    expect(await runRecordInspect({ verb: "frame", mp4: tty.mp4, t: 0, output: "-" }, tty.deps)).toBe(1);
    expect(tty.stdoutBytes).toHaveLength(0);
    expect(tty.err.join("\n")).toMatch(/refusing to write a PNG to a terminal/);
  });

  test("missing MP4, explicit missing --index, malformed default sidecar", async () => {
    const dir = tmp();
    const { deps, err, mp4 } = fakeDeps(dir);
    expect(await runRecordInspect({ verb: "frame", mp4: join(dir, "nope.mp4"), t: 0 }, deps)).toBe(1);
    expect(err.pop()).toMatch(/No such recording: .*nope\.mp4/);
    expect(await runRecordInspect({ verb: "frame", mp4, t: 0, index: join(dir, "gone.jsonl") }, deps)).toBe(1);
    expect(err.pop()).toMatch(/No recording index at .*gone\.jsonl/);
    writeFileSync(recordingIndexPath(mp4), "garbage\n");
    expect(await runRecordInspect({ verb: "frame", mp4, t: 0 }, deps)).toBe(1);
    expect(err.pop()).toMatch(/rec\.index\.jsonl:1: not valid JSON/);
  });
});

describe("runRecordInspect diff", () => {
  test("different frames: changedPixels and bbox, default PNG path", async () => {
    const { deps, out, mp4 } = fakeDeps(tmp());
    expect(await runRecordInspect({ verb: "diff", mp4, from: 0.3, to: 0.4 }, deps)).toBe(0);
    const result = JSON.parse(out[0]!);
    expect(result.from).toEqual({ i: 3, pts: 0.3, decodedPts: 0.3 });
    expect(result.to).toEqual({ i: 4, pts: 0.4, decodedPts: 0.4 });
    expect(result.changedPixels).toBe(1);
    expect(result.threshold).toBe(40);
    expect(result.maxDelta).toBe(135);
    expect(result.bbox).toEqual({ x: 2, y: 1, w: 1, h: 1 });
    expect(result.path).toBe(join(mp4, "..", "rec-diff-0.3-0.4.png"));
    expect(existsSync(result.path)).toBe(true);
  });

  test("identical frames: 0 changed, null bbox", async () => {
    const { deps, out, mp4 } = fakeDeps(tmp());
    expect(await runRecordInspect({ verb: "diff", mp4, from: 0.3, to: 0.5, output: join(tmp(), "d.png") }, deps)).toBe(0);
    const result = JSON.parse(out[0]!);
    expect(result.changedPixels).toBe(0);
    expect(result.bbox).toBeNull();
    expect(result.maxDelta).toBe(0);
  });

  test("--threshold is echoed; maxDelta shows how close a change came", async () => {
    const { deps, out, mp4 } = fakeDeps(tmp());
    expect(await runRecordInspect({ verb: "diff", mp4, from: 0.3, to: 0.4, threshold: 200, output: join(tmp(), "d.png") }, deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ changedPixels: 0, bbox: null, threshold: 200, maxDelta: 135 });
  });

  test("--from after --to is rejected like `changes` does", async () => {
    const { deps, err, decoded, mp4 } = fakeDeps(tmp());
    expect(await runRecordInspect({ verb: "diff", mp4, from: 0.5, to: 0.2 }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/record diff: --from 0\.5 is after --to 0\.2/);
    expect(decoded).toEqual([]);
  });

  test("a decoder that returns a different sample fails loudly", async () => {
    const base = fakeDeps(tmp());
    const { deps, err, mp4 } = fakeDeps(tmp(), {
      videoFrame: async (path, seconds) => ({ ...(await base.deps.videoFrame(path, seconds)), time: 0.2 }),
    });
    expect(await runRecordInspect({ verb: "frame", mp4, t: 0.3, output: join(tmp(), "x.png") }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/asked for sample i=3 at 0\.3 s but decoded the one at 0\.2 s/);
  });

  test("out-of-range --to is an error", async () => {
    const { deps, err, mp4 } = fakeDeps(tmp());
    expect(await runRecordInspect({ verb: "diff", mp4, from: 0, to: 3 }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/--to 3 is outside the recording/);
  });
});

describe("runRecordInspect changes", () => {
  test("reads the sidecar only", async () => {
    const { deps, out, decoded, mp4 } = fakeDeps(tmp(), { videoInfo: async () => { throw new Error("no decode"); } });
    writeSidecar(mp4);
    expect(await runRecordInspect({ verb: "changes", mp4, from: 0.1 }, deps)).toBe(0);
    const result = JSON.parse(out[0]!);
    expect(result.fps).toBe(10);
    expect(result.durationSec).toBe(0.6);
    expect(result.frames).toEqual([{ i: 3, pts: 0.3 }, { i: 4, pts: 0.4 }]);
    expect(result.events.map((e: { id: number; nextChange: unknown }) => [e.id, e.nextChange])).toEqual([[7, { i: 3, pts: 0.3 }]]);
    expect(result).toMatchObject({ complete: true, truncated: false, eventsDropped: 0, unmatchedEvents: [] });
    expect(decoded).toEqual([]);
  });

  test("a truncated or cut-short sidecar is flagged in the JSON and warned on stderr", async () => {
    const { deps, out, err, mp4 } = fakeDeps(tmp());
    const header = { type: "header", version: 1, fps: 10, clock: null };
    const frame = { type: "frame", i: 0, pts: 0, uptime: 0, changed: true };
    const write = (lines: object[]) => writeFileSync(recordingIndexPath(mp4), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    write([header, frame, { type: "footer", frames: 1, durationSec: 0.6, eventsDropped: 3, truncated: true }]);
    expect(await runRecordInspect({ verb: "changes", mp4 }, deps)).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ complete: true, truncated: true, eventsDropped: 3 });
    expect(err.join("\n")).toMatch(/warning: .*truncated/);
    expect(err.join("\n")).toMatch(/dropped 3 input event/);

    err.length = 0;
    write([header, frame]);
    expect(await runRecordInspect({ verb: "changes", mp4 }, deps)).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ complete: false, truncated: false, eventsDropped: 0 });
    expect(err.join("\n")).toMatch(/warning: .*no footer/);
  });

  test("missing sidecar: exit 1 telling the user to re-record without --no-index", async () => {
    const { deps, err, decoded, mp4 } = fakeDeps(tmp());
    expect(await runRecordInspect({ verb: "changes", mp4 }, deps)).toBe(1);
    expect(err.join("\n")).toMatch(/No recording index at .*rec\.index\.jsonl/);
    expect(err.join("\n")).toMatch(/re-record without --no-index/);
    expect(decoded).toEqual([]);
  });
});
