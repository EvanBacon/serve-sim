import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  RecordingIndexError,
  nearestIndex,
  parseRecordingIndex,
  readRecordingIndex,
  recordingChanges,
  recordingDuration,
} from "../recording-index-reader";
import { recordingIndexPath } from "../recording-index";

const header = {
  type: "header",
  version: 1,
  file: "rec.mp4",
  fps: 10,
  codec: "h264",
  width: 100,
  height: 200,
  rotation: 0,
  clock: { startUptime: 1, startWall: "2026-01-01T00:00:00.000Z", originUptime: 1, originWall: "2026-01-01T00:00:00.000Z", wallMinusUptimeSec: 0 },
  doc: {},
};

/** 10 fps, frames 0..9 (one skipped slot: pts 0.6 missing), changed at 0, 3, 4, 8. */
const frames = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10].map((slot, i) => ({
  type: "frame",
  i,
  pts: slot / 10,
  uptime: 1 + slot / 10,
  changed: [0, 3, 4, 7].includes(i),
}));

const events = [
  { type: "event", t: 0.25, id: 1, timestamp: "x", kind: "tap", action: "tap", summary: "Tap 0.5,0.5", x: 0.5, y: 0.5 },
  { type: "event", t: 0.5, tEnd: 0.75, id: 2, timestamp: "x", kind: "drag", summary: "Drag", x: 0.1, y: 0.2 },
  { type: "event", t: 0.95, id: 3, timestamp: "x", kind: "button", summary: "home" },
];

const footer = { type: "footer", frames: 10, changedFrames: 4, durationSec: 1.1, events: 3, eventsDropped: 0, truncated: false };

const jsonl = (lines: object[]) => lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
const sample = jsonl([header, ...frames, ...events, footer]);

describe("parseRecordingIndex", () => {
  test("splits header, frames, events, footer", () => {
    const index = parseRecordingIndex(sample, "rec.index.jsonl");
    expect(index.header.fps).toBe(10);
    expect(index.frames).toHaveLength(10);
    expect(index.frames[6]).toEqual({ i: 6, pts: 0.7, changed: false });
    expect(index.events.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(index.footer?.durationSec).toBe(1.1);
  });

  test("tolerates blank lines and a missing footer (cut-short file)", () => {
    const index = parseRecordingIndex(jsonl([header, frames[0]!]) + "\n\n", "x");
    expect(index.frames).toHaveLength(1);
    expect(index.footer).toBeNull();
  });

  test("rejects a non-JSON line with its line number", () => {
    const text = jsonl([header, frames[0]!]) + "{not json\n";
    expect(() => parseRecordingIndex(text, "bad.jsonl")).toThrow(/bad\.jsonl:3: not valid JSON/);
  });

  test("rejects a file that doesn't start with a header", () => {
    expect(() => parseRecordingIndex(jsonl([frames[0]!]), "x")).toThrow(/first line must be the header/);
    expect(() => parseRecordingIndex("", "x")).toThrow(/empty/);
  });

  test("rejects an unsupported version or a bad fps", () => {
    expect(() => parseRecordingIndex(jsonl([{ ...header, version: 2 }]), "x")).toThrow(/unsupported recording index version 2/);
    expect(() => parseRecordingIndex(jsonl([{ ...header, fps: 0 }]), "x")).toThrow(/fps/);
  });

  test("rejects a malformed frame line", () => {
    expect(() => parseRecordingIndex(jsonl([header, { type: "frame", i: 0, pts: "0" }]), "x")).toThrow(/x:2: malformed frame line/);
  });

  test("is a RecordingIndexError (not missing)", () => {
    try {
      parseRecordingIndex("nope\n", "x");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingIndexError);
      expect((error as RecordingIndexError).missing).toBe(false);
    }
  });
});

describe("readRecordingIndex", () => {
  test("reads a sidecar at the default path", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-index-"));
    const mp4 = join(dir, "rec.mp4");
    writeFileSync(recordingIndexPath(mp4), sample);
    expect(readRecordingIndex(recordingIndexPath(mp4)).frames).toHaveLength(10);
  });

  test("a missing sidecar is a RecordingIndexError with missing=true", () => {
    const path = join(mkdtempSync(join(tmpdir(), "rec-index-")), "gone.index.jsonl");
    try {
      readRecordingIndex(path);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingIndexError);
      expect((error as RecordingIndexError).missing).toBe(true);
      expect((error as Error).message).toContain(path);
    }
  });
});

describe("nearestIndex (nearest frame at t)", () => {
  const index = parseRecordingIndex(sample, "x");
  const times = index.frames.map((f) => f.pts);
  const at = (t: number) => index.frames[nearestIndex(times, t)]?.i;

  test("exact and in-between times pick the nearest sample", () => {
    expect(at(0)).toBe(0);
    expect(at(0.31)).toBe(3);
    expect(at(0.36)).toBe(4);
    expect(at(10)).toBe(9);
  });

  test("a tie goes to the earlier sample", () => {
    expect(at(0.15)).toBe(1);
  });

  test("across a skipped slot (pts 0.6 missing)", () => {
    expect(at(0.6)).toBe(5); // 0.5 and 0.7 tie → earlier
    expect(at(0.62)).toBe(6);
  });

  test("no frames → -1", () => {
    expect(nearestIndex([], 1)).toBe(-1);
  });
});

describe("recordingDuration", () => {
  test("footer durationSec, else last pts + one frame", () => {
    expect(recordingDuration(parseRecordingIndex(sample, "x"))).toBe(1.1);
    const cut = parseRecordingIndex(jsonl([header, ...frames.slice(0, 3)]), "x");
    expect(recordingDuration(cut)).toBeCloseTo(0.3, 9);
  });
});

describe("recordingChanges", () => {
  const index = parseRecordingIndex(sample, "x");

  test("whole recording: header info, changed frames, events near them", () => {
    const result = recordingChanges(index, {});
    expect(result.fps).toBe(10);
    expect(result.durationSec).toBe(1.1);
    expect(result.clock).toEqual(header.clock);
    expect(result.window).toEqual({ from: 0, to: 1.1 });
    expect(result.frames).toEqual([{ i: 0, pts: 0 }, { i: 3, pts: 0.3 }, { i: 4, pts: 0.4 }, { i: 7, pts: 0.8 }]);
    expect(result.changedFrames).toBe(4);
    // Each kept event names the first changed frame at/after it.
    expect(result.events.map((e) => [e.id, e.nextChange?.i ?? null])).toEqual([[1, 3], [2, 7], [3, null]]);
    expect(result.unmatchedEvents).toEqual([]);
    expect(result).toMatchObject({ complete: true, truncated: false, eventsDropped: 0 });
  });

  test("events with no changed frame within near go to unmatchedEvents (a missed tap)", () => {
    const result = recordingChanges(index, { near: 0.06 });
    expect(result.events.map((e) => e.id)).toEqual([1, 2]);
    expect(result.unmatchedEvents.map((e) => e.id)).toEqual([3]);
    // Only events in the window are listed.
    expect(recordingChanges(index, { from: 0, to: 0.9, near: 0.04 }).unmatchedEvents.map((e) => e.id)).toEqual([1, 2]);
  });

  test("surfaces an incomplete sidecar: truncated, eventsDropped, missing footer", () => {
    const truncated = parseRecordingIndex(jsonl([header, ...frames, { ...footer, truncated: true, eventsDropped: 4 }]), "x");
    expect(recordingChanges(truncated, {})).toMatchObject({ complete: true, truncated: true, eventsDropped: 4 });
    const cut = parseRecordingIndex(jsonl([header, ...frames, ...events]), "x");
    expect(recordingChanges(cut, {})).toMatchObject({ complete: false, truncated: false, eventsDropped: 0 });
  });

  test("a window keeps only its changed frames and nearby events", () => {
    const result = recordingChanges(index, { from: 0.35, to: 0.9 });
    expect(result.frames.map((f) => f.i)).toEqual([4, 7]);
    expect(result.events.map((e) => e.id)).toEqual([1, 2]);
  });

  test("near controls how close an event must be to a changed frame", () => {
    // Drag [0.5, 0.75] is 0.05 from frame 7 (0.8); tap 0.25 is 0.05 from frame 3.
    expect(recordingChanges(index, { near: 0.04 }).events.map((e) => e.id)).toEqual([]);
    expect(recordingChanges(index, { near: 0.06 }).events.map((e) => e.id)).toEqual([1, 2]);
    // Home at 0.95 is 0.15 after frame 7.
    expect(recordingChanges(index, { near: 0.2 }).events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  test("a window with no changes has no events", () => {
    const result = recordingChanges(index, { from: 0.5, to: 0.75 });
    expect(result.frames).toEqual([]);
    expect(result.events).toEqual([]);
  });

  test("rejects an inverted window", () => {
    expect(() => recordingChanges(index, { from: 0.8, to: 0.2 })).toThrow(/--from .* after --to/);
  });
});
