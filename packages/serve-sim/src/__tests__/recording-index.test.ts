import { describe, expect, test } from "bun:test";
import type { EventLogEntry } from "../event-log";
import {
  RecordingEventCollector,
  recordingClock,
  recordingIndexEvents,
  recordingIndexLines,
  recordingIndexPath,
  splitRecordingSummary,
  type NativeRecordingIndex,
} from "../recording-index";

// Recorder armed at uptime 1000 s == 2026-11-09T12:00:00.000Z; first frame
// (pts 0) captured 0.25 s later.
const ARMED_WALL_MS = Date.parse("2026-11-09T12:00:00.000Z");
const native: NativeRecordingIndex = {
  version: 1,
  fps: 60,
  clock: { armedUptime: 1000, armedWallMs: ARMED_WALL_MS, originUptime: 1000.25 },
  slots: [0, 1, 2, 4],
  uptimesUs: [1_000_250_000, 1_000_250_000, 1_000_283_333, 1_000_316_667],
  changed: [1, 0, 1, 0],
  changedCount: 2,
  truncated: false,
};

function hidEvent(id: number, timestamp: string, overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id,
    timestamp,
    source: "hid",
    kind: "tap",
    action: "tap",
    msg: "Tap",
    summary: "Tap (0.5, 0.5)",
    device: "UDID",
    details: { type: "tap", start: { x: 0.5, y: 0.5 }, current: { x: 0.5, y: 0.5 }, moveCount: 0 },
    ...overrides,
  };
}

describe("splitRecordingSummary", () => {
  test("separates the native index from the summary without touching other fields", () => {
    const raw = JSON.stringify({ path: "/tmp/x.mp4", width: 10, frames: 4, index: native });
    const split = splitRecordingSummary(raw);
    expect(split.summary).toEqual({ path: "/tmp/x.mp4", width: 10, frames: 4 });
    expect(split.index).toEqual(native);
  });

  test("summaries from addons without an index yield null", () => {
    expect(splitRecordingSummary(JSON.stringify({ frames: 1 })).index).toBeNull();
    expect(splitRecordingSummary("not json")).toEqual({ summary: {}, index: null });
  });
});

describe("native index validation", () => {
  const parse = (index: unknown) => splitRecordingSummary(JSON.stringify({ frames: 1, index })).index;
  test("rejects malformed or mismatched arrays", () => {
    expect(parse(native)).toEqual(native);
    expect(parse({ ...native, version: 2 })).toBeNull();
    expect(parse({ ...native, slots: [0] })).toBeNull();
    expect(parse({ ...native, fps: 0 })).toBeNull();
    expect(parse({ ...native, uptimesUs: ["x", 1, 2, 3] })).toBeNull();
    expect(parse(null)).toBeNull();
  });
});

describe("recordingClock", () => {
  test("joins wall clock and uptime with one offset sampled at start", () => {
    const clock = recordingClock(native)!;
    expect(clock.startUptime).toBe(1000);
    expect(clock.startWall).toBe("2026-11-09T12:00:00.000Z");
    expect(clock.originUptime).toBe(1000.25);
    expect(clock.originWall).toBe("2026-11-09T12:00:00.250Z");
    expect(clock.wallMinusUptimeSec).toBeCloseTo(ARMED_WALL_MS / 1000 - 1000, 6);
  });

  test("is null when no frame was ever placed", () => {
    const { originUptime: _, ...rest } = native.clock;
    expect(recordingClock({ ...native, clock: rest })).toBeNull();
  });
});

describe("event media time", () => {
  test("maps an ISO wall time onto the media timeline: t = wall - offset - originUptime", () => {
    const clock = recordingClock(native)!;
    const t = (timestamp: string) => recordingIndexEvents([hidEvent(1, timestamp)], clock, { durationSec: 10 })[0]?.t;
    expect(t("2026-11-09T12:00:00.250Z")).toBe(0);
    expect(t("2026-11-09T12:00:01.750Z")).toBe(1.5);
    expect(t("2026-11-09T12:00:00.249Z")).toBeUndefined(); // before pts 0
    expect(t("2026-11-09T12:00:10.250Z")).toBe(10); // the end is inclusive
    expect(t("garbage")).toBeUndefined();
  });

  test("uses the offset sampled at start, not origin", () => {
    // Same wall time, origin captured later -> the event is earlier in media time.
    const later = recordingClock({ ...native, clock: { ...native.clock, originUptime: 1001 } })!;
    expect(recordingIndexEvents([hidEvent(1, "2026-11-09T12:00:01.750Z")], later, { durationSec: 10 })[0]?.t).toBe(0.75);
  });
});

describe("recordingIndexEvents", () => {
  const clock = recordingClock(native)!;

  test("keeps HID events for the device inside [0, duration], sorted by t", () => {
    const events = recordingIndexEvents([
      hidEvent(3, "2026-11-09T12:00:02.250Z"),
      hidEvent(1, "2026-11-09T12:00:00.100Z"), // before pts 0
      hidEvent(2, "2026-11-09T12:00:00.750Z", { kind: "button", action: "home", summary: "Button home", details: { button: "home", phase: "press" } }),
      hidEvent(4, "2026-11-09T12:00:09.000Z"), // after the end
      hidEvent(5, "2026-11-09T12:00:01.000Z", { device: "OTHER" }),
      hidEvent(6, "2026-11-09T12:00:01.000Z", { source: "exec", kind: "command" }),
    ], clock, { durationSec: 5, device: "UDID" });
    expect(events.map((e) => e.id)).toEqual([2, 3]);
    expect(events[0]).toEqual({ type: "event", t: 0.5, id: 2, timestamp: "2026-11-09T12:00:00.750Z", kind: "button", action: "home", summary: "Button home" });
    expect(events[1]).toMatchObject({ t: 2, kind: "tap", x: 0.5, y: 0.5 });
  });

  test("carries normalized coordinates for touches, drags and scrolls", () => {
    const [touch, drag, scroll] = recordingIndexEvents([
      hidEvent(1, "2026-11-09T12:00:01.000Z", { kind: "touch", action: "begin", details: { type: "begin", x: 0.1, y: 0.2, screen: { width: 1, height: 1 } } }),
      hidEvent(2, "2026-11-09T12:00:01.100Z", { kind: "drag", action: "drag", details: { start: { x: 0.1, y: 0.2 }, current: { x: 0.3, y: 0.9 }, moveCount: 4, edge: 1 } }),
      hidEvent(3, "2026-11-09T12:00:01.200Z", { kind: "scroll", action: "wheel", details: { dx: 0, dy: -3, x: 0.4, y: 0.6 } }),
    ], clock, { durationSec: 5 });
    expect(touch).toMatchObject({ x: 0.1, y: 0.2 });
    expect(touch).not.toHaveProperty("screen");
    expect(drag).toMatchObject({ x: 0.3, y: 0.9, start: { x: 0.1, y: 0.2 }, edge: 1 });
    expect(scroll).toMatchObject({ x: 0.4, y: 0.6, dx: 0, dy: -3 });
  });
});

describe("RecordingEventCollector", () => {
  test("keeps the latest version of each HID event for its device, bounded", () => {
    const collector = new RecordingEventCollector("UDID", 2);
    collector.add(hidEvent(1, "t1", { summary: "Drag a" }));
    collector.add(hidEvent(1, "t1", { summary: "Drag b" }));
    collector.add(hidEvent(2, "t2", { device: "OTHER" }));
    collector.add(hidEvent(3, "t3", { source: "ui" }));
    collector.add(hidEvent(4, "t4"));
    collector.add(hidEvent(5, "t5"));
    expect(collector.entries().map((e) => [e.id, e.summary])).toEqual([[1, "Drag b"], [4, "Tap (0.5, 0.5)"]]);
    expect(collector.dropped).toBe(1);
  });
});

describe("recordingIndexLines", () => {
  test("serialises header, frames, events and footer as JSONL", () => {
    const clock = recordingClock(native)!;
    const events = recordingIndexEvents([hidEvent(9, "2026-11-09T12:00:00.283Z")], clock, { durationSec: 5 / 60 });
    const text = [...recordingIndexLines({
      file: "rec.mp4",
      summary: { width: 1206, height: 2622, fps: 60, codec: "h264", rotation: 90, duration: 5 / 60 },
      index: native,
      events,
    })].join("");
    expect(text.endsWith("\n")).toBe(true);
    const lines = text.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((l) => l.type)).toEqual(["header", "frame", "frame", "frame", "frame", "event", "footer"]);
    expect(lines[0]).toMatchObject({
      type: "header",
      version: 1,
      file: "rec.mp4",
      fps: 60,
      codec: "h264",
      width: 1206,
      height: 2622,
      rotation: 90,
      clock: { startUptime: 1000, originUptime: 1000.25, originWall: "2026-11-09T12:00:00.250Z" },
    });
    expect(typeof lines[0].clock.eventMapping).toBe("string");
    expect(lines.slice(1, 5)).toEqual([
      { type: "frame", i: 0, pts: 0, uptime: 1000.25, changed: true },
      { type: "frame", i: 1, pts: 0.016667, uptime: 1000.25, changed: false },
      { type: "frame", i: 2, pts: 0.033333, uptime: 1000.283333, changed: true },
      { type: "frame", i: 3, pts: 0.066667, uptime: 1000.316667, changed: false },
    ]);
    expect(lines[5]).toMatchObject({ type: "event", id: 9, t: 0.033 });
    expect(lines[6]).toEqual({ type: "footer", frames: 4, changedFrames: 2, durationSec: 0.083333, events: 1, truncated: false });
  });

  test("batches frame lines into chunks for streaming", () => {
    const n = 2500;
    const big: NativeRecordingIndex = {
      ...native,
      slots: Array.from({ length: n }, (_, i) => i),
      uptimesUs: Array.from({ length: n }, (_, i) => 1_000_250_000 + i * 16_667),
      changed: Array.from({ length: n }, (_, i) => (i % 2 ? 0 : 1)),
      changedCount: n / 2,
    };
    const chunks = [...recordingIndexLines({ file: "a.mp4", summary: { duration: n / 60 }, index: big, events: [] })];
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.length).toBeLessThan(10);
    expect(chunks.join("").trimEnd().split("\n")).toHaveLength(n + 2);
  });
});

describe("recordingIndexPath", () => {
  test("puts the sidecar next to the MP4", () => {
    expect(recordingIndexPath("/a/b/rec.mp4")).toBe("/a/b/rec.index.jsonl");
    expect(recordingIndexPath("/a/b/rec.MP4")).toBe("/a/b/rec.index.jsonl");
    expect(recordingIndexPath("/a/b/rec")).toBe("/a/b/rec.index.jsonl");
    expect(recordingIndexPath("/a/b.c/rec.mov")).toBe("/a/b.c/rec.mov.index.jsonl");
  });
});
