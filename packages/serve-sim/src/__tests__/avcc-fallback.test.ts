import { describe, expect, test } from "bun:test";
import {
  avccFallbackReducer,
  initialAvccFallback,
  type AvccFallbackState,
} from "../client/avcc-fallback";

/** Apply a sequence of events from the initial state. */
function run(events: Parameters<typeof avccFallbackReducer>[1][]): AvccFallbackState {
  return events.reduce(avccFallbackReducer, initialAvccFallback);
}

describe("avccFallbackReducer", () => {
  test("starts on AVCC (no fallback) until told otherwise", () => {
    expect(initialAvccFallback).toEqual({ streamed: false, fellBack: false });
  });

  test("timeout without a frame falls back to MJPEG", () => {
    // The repro: helper has no /stream.avcc route, so no frame ever arrives.
    expect(run(["timeout"]).fellBack).toBe(true);
  });

  test("a frame before timeout keeps AVCC", () => {
    // Healthy helper paints its JPEG seed first, cancelling the fallback.
    const state = run(["frame", "timeout"]);
    expect(state.streamed).toBe(true);
    expect(state.fellBack).toBe(false);
  });

  test("a late stall does not downgrade a stream that already worked", () => {
    // frame → working; a later timeout (e.g. transient stall) must not flip us
    // to MJPEG permanently.
    expect(run(["frame", "timeout", "timeout"]).fellBack).toBe(false);
  });

  test("reset re-arms AVCC after a device switch / reconnect", () => {
    const fellBack = run(["timeout"]);
    expect(fellBack.fellBack).toBe(true);
    expect(avccFallbackReducer(fellBack, "reset")).toEqual(initialAvccFallback);
  });

  test("once fallen back, further timeouts are idempotent", () => {
    const once = run(["timeout"]);
    expect(avccFallbackReducer(once, "timeout")).toEqual(once);
  });
});
