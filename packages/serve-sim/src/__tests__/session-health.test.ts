import { describe, expect, test } from "bun:test";
import { SessionHealth } from "../session-health";

describe("SessionHealth", () => {
  test("reports starting until the first frame arrives", () => {
    let now = 1_000;
    const health = new SessionHealth("TEST-UDID", {
      now: () => now,
      startupTimeoutMs: 10_000,
      staleAfterMs: 3_000,
    });

    health.markRunning();
    now = 2_000;

    expect(health.snapshot({ mjpeg: 0, avcc: 0, hid: 0 })).toEqual({
      status: "starting",
      ready: false,
      device: "TEST-UDID",
      phase: "running",
      startedAt: "1970-01-01T00:00:01.000Z",
      checkedAt: "1970-01-01T00:00:02.000Z",
      uptimeMs: 1_000,
      screen: null,
      clients: { mjpeg: 0, avcc: 0, hid: 0, total: 0 },
      frames: {
        mjpeg: 0,
        avcc: 0,
        lastAt: null,
        lastCodec: null,
        staleForMs: null,
      },
      error: null,
    });
    expect(health.httpStatus()).toBe(425);
  });

  test("reports frame, screen, and client diagnostics when ready", () => {
    let now = 10_000;
    const health = new SessionHealth("TEST-UDID", { now: () => now });
    health.markRunning();

    now = 10_250;
    health.recordFrame("mjpeg", { width: 1_206, height: 2_622 });
    now = 10_300;
    health.recordFrame("avcc", { width: 1_206, height: 2_622 });

    const snapshot = health.snapshot({ mjpeg: 2, avcc: 1, hid: 3 }, "landscape_left");
    expect(snapshot.status).toBe("ok");
    expect(snapshot.ready).toBe(true);
    expect(snapshot.screen).toEqual({
      width: 1_206,
      height: 2_622,
      orientation: "landscape_left",
    });
    expect(snapshot.clients).toEqual({ mjpeg: 2, avcc: 1, hid: 3, total: 6 });
    expect(snapshot.frames).toEqual({
      mjpeg: 1,
      avcc: 1,
      lastAt: "1970-01-01T00:00:10.300Z",
      lastCodec: "avcc",
      staleForMs: 0,
    });
    expect(health.httpStatus()).toBe(200);
  });

  test("distinguishes a stalled stream from a startup in progress", () => {
    let now = 20_000;
    const health = new SessionHealth("TEST-UDID", {
      now: () => now,
      startupTimeoutMs: 10_000,
      staleAfterMs: 3_000,
    });
    health.markRunning();

    now = 30_001;
    expect(health.snapshot({ mjpeg: 0, avcc: 0, hid: 0 }).status).toBe("stalled");
    expect(health.httpStatus()).toBe(503);

    health.recordFrame("mjpeg", { width: 100, height: 200 });
    expect(health.snapshot({ mjpeg: 0, avcc: 0, hid: 0 }).status).toBe("ok");

    now = 33_001;
    const stale = health.snapshot({ mjpeg: 0, avcc: 0, hid: 0 });
    expect(stale.status).toBe("stalled");
    expect(stale.frames.staleForMs).toBe(3_000);
  });

  test("preserves failure details and stopped state", () => {
    let now = 40_000;
    const failed = new SessionHealth("TEST-UDID", { now: () => now });
    failed.markRunning();
    now = 40_500;
    failed.markFailed(new Error("capture subscription failed"));

    expect(failed.snapshot({ mjpeg: 0, avcc: 0, hid: 0 }).error).toEqual({
      message: "capture subscription failed",
      at: "1970-01-01T00:00:40.500Z",
    });
    expect(failed.snapshot({ mjpeg: 0, avcc: 0, hid: 0 }).status).toBe("failed");
    expect(failed.httpStatus()).toBe(503);

    const stopped = new SessionHealth("TEST-UDID", { now: () => now });
    stopped.markRunning();
    stopped.markStopped();
    expect(stopped.snapshot({ mjpeg: 0, avcc: 0, hid: 0 }).status).toBe("stopped");
    expect(stopped.httpStatus()).toBe(503);
  });

  test("restarts startup timing and clears stale frame state on retry", () => {
    let now = 50_000;
    const health = new SessionHealth("TEST-UDID", {
      now: () => now,
      startupTimeoutMs: 10_000,
    });
    health.markRunning();
    now = 50_500;
    health.recordFrame("mjpeg", { width: 100, height: 200 });
    now = 51_000;
    health.markFailed(new Error("capture failed"));

    now = 70_000;
    health.markStarting();
    const retrying = health.snapshot({ mjpeg: 0, avcc: 0, hid: 0 });
    expect(retrying.status).toBe("starting");
    expect(retrying.startedAt).toBe("1970-01-01T00:01:10.000Z");
    expect(retrying.frames).toMatchObject({
      mjpeg: 1,
      lastAt: null,
      lastCodec: null,
      staleForMs: null,
    });

    now = 80_001;
    expect(health.snapshot({ mjpeg: 0, avcc: 0, hid: 0 }).status).toBe("stalled");
  });
});
