import { describe, expect, test } from "bun:test";
import {
  MAX_RECORDING_MS,
  clampRecordingDuration,
  parseRecordingDuration,
  parseRecordingQuery,
  recordingFileName,
  recordingRotation,
  uniqueRecordingFileName,
  recordingUrlForWsUrl,
  recordingPollOutcome,
} from "../recording";

describe("parseRecordingQuery", () => {
  test("defaults to 60 fps H.264", () => {
    expect(parseRecordingQuery(new URLSearchParams())).toEqual({ codec: "h264", fps: 60 });
  });

  test("accepts hevc, fps and bitrate", () => {
    expect(parseRecordingQuery(new URLSearchParams("codec=HEVC&fps=30&bitrate=20000000"))).toEqual({
      codec: "hevc",
      fps: 30,
      bitrate: 20_000_000,
    });
  });

  test.each(["codec=vp9", "fps=0", "fps=121", "fps=29.97", "bitrate=1e3", "bitrate=abc"])("rejects %s", (query) => {
    expect(parseRecordingQuery(new URLSearchParams(query))).toHaveProperty("error");
  });
});

describe("recordingRotation", () => {
  test("portrait plays as captured", () => {
    expect(recordingRotation({ width: 1206, height: 2622, orientation: "portrait" })).toBe(0);
  });

  test("matches the viewer's CSS rotation for a portrait framebuffer in landscape", () => {
    expect(recordingRotation({ width: 1206, height: 2622, orientation: "landscape_left" })).toBe(90);
    expect(recordingRotation({ width: 1206, height: 2622, orientation: "landscape_right" })).toBe(-90);
    expect(recordingRotation({ width: 1206, height: 2622, orientation: "portrait_upside_down" })).toBe(180);
  });

  test("an already-landscape framebuffer needs no transform", () => {
    expect(recordingRotation({ width: 2752, height: 2064, orientation: "landscape_left" })).toBe(0);
  });
});

test("recordingFileName is a sortable local timestamp", () => {
  expect(recordingFileName(new Date(2026, 9, 2, 3, 4, 5))).toBe("serve-sim-recording-2026-10-02-03-04-05.mp4");
});

describe("uniqueRecordingFileName", () => {
  test("keeps the timestamped name when it's free", () => {
    expect(uniqueRecordingFileName("serve-sim-recording-x.mp4", () => false)).toBe("serve-sim-recording-x.mp4");
  });

  test("suffixes a counter when recordings land in the same second", () => {
    const taken = new Set(["a.mp4", "a-2.mp4"]);
    expect(uniqueRecordingFileName("a.mp4", (name) => taken.has(name))).toBe("a-3.mp4");
  });
});

describe("recordingUrlForWsUrl", () => {
  test("maps the HID socket to the recording routes", () => {
    const ws = "ws://127.0.0.1:3400/helper/ABC/ws";
    expect(recordingUrlForWsUrl(ws)).toBe("http://127.0.0.1:3400/helper/ABC/recording");
    expect(recordingUrlForWsUrl(ws, "start")).toBe("http://127.0.0.1:3400/helper/ABC/recording/start");
    expect(recordingUrlForWsUrl("wss://x.example/base/helper/ABC/ws", "stop"))
      .toBe("https://x.example/base/helper/ABC/recording/stop");
  });

  test("rejects non-socket URLs", () => {
    expect(recordingUrlForWsUrl("not a url")).toBeNull();
    expect(recordingUrlForWsUrl("ws://127.0.0.1:3400/helper/ABC/config")).toBeNull();
  });
});

describe("parseRecordingDuration", () => {
  test.each([["10", 10_000], ["10s", 10_000], ["1.5m", 90_000], ["500ms", 500]] as const)("%s", (raw, ms) => {
    expect(parseRecordingDuration(raw)).toBe(ms);
  });

  test.each(["", "0", "-1", "abc", "10h"])("rejects %p", (raw) => {
    expect(parseRecordingDuration(raw)).toBeNull();
  });
});

describe("clampRecordingDuration", () => {
  test("keeps durations within the server cap", () => {
    expect(clampRecordingDuration(10_000)).toBe(10_000);
    expect(clampRecordingDuration(MAX_RECORDING_MS)).toBe(MAX_RECORDING_MS);
  });

  test("caps longer durations (and ones too large for a timer) at the server limit", () => {
    expect(clampRecordingDuration(MAX_RECORDING_MS + 1)).toBe(MAX_RECORDING_MS);
    expect(clampRecordingDuration(parseRecordingDuration("999999999m")!)).toBe(MAX_RECORDING_MS);
  });
});

describe("recordingPollOutcome", () => {
  const startedAt = "2026-10-23T00:00:00.000Z";

  test("keeps recording while the server reports our recording", () => {
    expect(recordingPollOutcome({ recording: true, startedAt }, startedAt)).toBe("recording");
  });

  test("collects once the duration cap holds the file for us", () => {
    expect(recordingPollOutcome({ recording: true, startedAt, limitReached: true }, startedAt)).toBe("limit");
  });

  test("notices another client stopped the recording", () => {
    expect(recordingPollOutcome({ recording: false }, startedAt)).toBe("stopped-elsewhere");
  });

  test("notices our recording was replaced by another one", () => {
    expect(recordingPollOutcome({ recording: true, startedAt: "2026-10-23T00:05:00.000Z" }, startedAt))
      .toBe("stopped-elsewhere");
  });

  test("ignores unreadable status", () => {
    expect(recordingPollOutcome(null, startedAt)).toBe("recording");
  });
});
