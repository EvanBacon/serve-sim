import { describe, expect, test } from "bun:test";
import { parseRecordingIndex } from "../recording-index-reader";
import {
  activeMarker,
  adjacentMarker,
  clampTime,
  describeMarker,
  formatTimelineTime,
  frameIndexAt,
  recordingSeekTime,
  stepFrame,
  timelineFromBufferView,
  timelineFromRecordingIndex,
  type TimelineSource,
} from "../client/utils/scrub-timeline";

const SIDECAR = [
  { type: "header", version: 1, fps: 10, codec: "h264", width: 100, height: 200, clock: null },
  { type: "frame", i: 0, pts: 0, uptime: 1, changed: true },
  { type: "frame", i: 1, pts: 0.1, uptime: 1.1, changed: false },
  { type: "frame", i: 2, pts: 0.2, uptime: 1.2, changed: true },
  { type: "frame", i: 3, pts: 0.3, uptime: 1.3, changed: true },
  { type: "event", t: 0.25, id: 9, timestamp: "2026-11-10T00:00:00.250Z", kind: "drag", action: "drag", summary: "Drag", tEnd: 0.35, x: 0.5, y: 0.2, start: { x: 0.5, y: 0.8 } },
  { type: "event", t: 0.05, id: 7, timestamp: "2026-11-10T00:00:00.050Z", kind: "tap", action: "tap", summary: "Tap 0.25, 0.5", x: 0.25, y: 0.5 },
  { type: "event", t: 0.15, id: 8, timestamp: "2026-11-10T00:00:00.150Z", kind: "button", summary: "Button home" },
  { type: "footer", frames: 4, changedFrames: 3, durationSec: 0.4 },
].map((line) => JSON.stringify(line)).join("\n");

function recording(): TimelineSource {
  return timelineFromRecordingIndex(parseRecordingIndex(SIDECAR, "test"));
}

describe("timelineFromRecordingIndex", () => {
  test("carries the header's raw size and track rotation for marker placement", () => {
    expect(recording().frame).toEqual({ width: 100, height: 200, rotation: 0 });
    const rotated = SIDECAR.replace('"clock":null', '"rotation":90,"clock":null');
    expect(timelineFromRecordingIndex(parseRecordingIndex(rotated, "test")).frame).toEqual({ width: 100, height: 200, rotation: 90 });
    const unsized = SIDECAR.replace('"width":100,"height":200,', '"width":null,"height":null,');
    expect(timelineFromRecordingIndex(parseRecordingIndex(unsized, "test")).frame).toEqual({ rotation: 0 });
  });

  test("uses frame pts, the footer duration, and sorted markers", () => {
    const source = recording();
    expect(source.kind).toBe("recording");
    expect(source.duration).toBe(0.4);
    expect(source.fps).toBe(10);
    expect(source.frames.map((f) => [f.t, f.frame, f.changed])).toEqual([
      [0, 0, true], [0.1, 1, false], [0.2, 2, true], [0.3, 3, true],
    ]);
    expect(source.markers.map((m) => [m.id, m.kind, m.rawKind])).toEqual([
      [7, "tap", "tap"], [8, "other", "button"], [9, "drag", "drag"],
    ]);
    expect(source.markers[0]).toMatchObject({ x: 0.25, y: 0.5 });
    expect(source.markers[2]).toMatchObject({ tEnd: 0.35, start: { x: 0.5, y: 0.8 } });
  });

  test("without a footer the duration is the last pts plus one frame", () => {
    const cut = SIDECAR.split("\n").filter((l) => !l.includes('"footer"')).join("\n");
    expect(timelineFromRecordingIndex(parseRecordingIndex(cut, "t")).duration).toBeCloseTo(0.4, 9);
  });
});

describe("timelineFromBufferView", () => {
  const view = {
    origin: "2026-11-10T00:00:00.000Z",
    now: "2026-11-10T00:00:01.000Z",
    samples: [
      { t: 0, at: "", frame: 1, changed: true },
      { t: 0.25, at: "", frame: 1, changed: false },
      { t: 0.5, at: "", frame: 2, changed: true },
    ],
    events: [
      { type: "event" as const, t: 0.4, id: 3, timestamp: "", kind: "tap", summary: "Tap", x: 0.1, y: 0.9, frame: 1 },
    ],
  };

  test("spans origin → now and keeps frame ids", () => {
    const source = timelineFromBufferView(view)!;
    expect(source.kind).toBe("buffer");
    expect(source.duration).toBe(1);
    expect(source.origin).toBe(view.origin);
    expect(source.frames.map((f) => f.frame)).toEqual([1, 1, 2]);
    expect(source.markers).toEqual([{ id: 3, t: 0.4, kind: "tap", rawKind: "tap", summary: "Tap", x: 0.1, y: 0.9 }]);
  });

  test("an empty or off buffer has no source", () => {
    expect(timelineFromBufferView({ ...view, origin: null, samples: [] })).toBeNull();
    expect(timelineFromBufferView({ ...view, samples: [] })).toBeNull();
  });

  test("tolerates a view fetched with events=0", () => {
    const { events: _events, ...rest } = view;
    expect(timelineFromBufferView(rest as typeof view)!.markers).toEqual([]);
  });
});

describe("seeking", () => {
  test("frameIndexAt picks the frame on screen at t", () => {
    const { frames } = recording();
    expect(frameIndexAt(frames, -1)).toBe(0);
    expect(frameIndexAt(frames, 0)).toBe(0);
    expect(frameIndexAt(frames, 0.099)).toBe(0);
    expect(frameIndexAt(frames, 0.1)).toBe(1);
    expect(frameIndexAt(frames, 0.25)).toBe(2);
    expect(frameIndexAt(frames, 9)).toBe(3);
    expect(frameIndexAt([], 1)).toBe(-1);
  });

  test("stepFrame lands on neighbouring frame times and stops at the ends", () => {
    const source = recording();
    expect(stepFrame(source, 0.15, 1)).toBe(0.2);
    expect(stepFrame(source, 0.15, -1)).toBe(0);
    expect(stepFrame(source, 0.3, 1)).toBe(0.3);
    expect(stepFrame(source, 0, -1)).toBe(0);
  });

  test("clampTime stays inside the track", () => {
    const source = recording();
    expect(clampTime(source, -2)).toBe(0);
    expect(clampTime(source, 5)).toBe(0.4);
    expect(clampTime(source, Number.NaN)).toBe(0);
  });

  test("adjacentMarker steps past the current time", () => {
    const source = recording();
    expect(adjacentMarker(source, 0, 1)?.id).toBe(7);
    expect(adjacentMarker(source, 0.05, 1)?.id).toBe(8);
    expect(adjacentMarker(source, 0.25, -1)?.id).toBe(8);
    expect(adjacentMarker(source, 0.05, -1)).toBeNull();
    expect(adjacentMarker(source, 0.25, 1)).toBeNull();
  });

  test("activeMarker is the latest marker within the window, or a drag in progress", () => {
    const source = recording();
    expect(activeMarker(source, 0)).toBeNull();
    expect(activeMarker(source, 0.06)?.id).toBe(7);
    expect(activeMarker(source, 0.06, 0)).toBeNull();
    expect(activeMarker(source, 0.3, 0)?.id).toBe(9);
    expect(activeMarker(source, 2)).toBeNull();
  });

  test("recordingSeekTime asks for the middle of the shown sample", () => {
    const source = recording();
    expect(recordingSeekTime(source, 0)).toBeCloseTo(0.05, 9);
    expect(recordingSeekTime(source, 0.12)).toBeCloseTo(0.15, 9);
    // Last sample: half a frame (clamped to the duration).
    expect(recordingSeekTime(source, 0.39)).toBeCloseTo(0.35, 9);
  });
});

describe("labels", () => {
  test("formatTimelineTime", () => {
    expect(formatTimelineTime(0)).toBe("0:00.00");
    expect(formatTimelineTime(3.254)).toBe("0:03.25");
    expect(formatTimelineTime(61.5)).toBe("1:01.50");
    expect(formatTimelineTime(59.999)).toBe("1:00.00");
    expect(formatTimelineTime(-1)).toBe("0:00.00");
  });

  test("describeMarker names the kind, time, and point", () => {
    const [tap, button, drag] = recording().markers;
    expect(describeMarker(tap!)).toBe("tap · 0:00.05 · at 25%, 50%");
    expect(describeMarker(button!)).toBe("button · 0:00.15");
    expect(describeMarker(drag!)).toBe("drag · 0:00.25–0:00.35 · 50%, 80% → 50%, 20%");
  });
});
