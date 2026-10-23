import { describe, expect, test } from "bun:test";
import {
  parseRecordingDuration,
  parseRecordingQuery,
  recordingFileName,
  recordingRotation,
  uniqueRecordingFileName,
  recordingUrlForWsUrl,
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
