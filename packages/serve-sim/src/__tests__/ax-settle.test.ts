import { describe, expect, test } from "bun:test";
import { clampSettleTimeout, waitForSettle, type SettleOptions } from "../ax-settle";

/**
 * Simulated device on a virtual clock: `frames(t)` is the content-frame
 * counter and `screen(t)` the AX signature at time t (ms since the settle
 * started). An AX read takes `readMs` and reports the tree as of when it
 * began. `sleep` parks on a timer queue; `run` advances time to the next
 * timer whenever every coroutine is blocked, so the frame poller that runs
 * alongside a read interleaves with it deterministically.
 */
function world(opts: {
  frames?: ((t: number) => number) | null;
  screen?: (t: number) => string;
  readMs?: number;
  readError?: (t: number) => Error | null;
}) {
  let t = 0;
  const reads: number[] = [];
  const sleeps: number[] = [];
  const timers: Array<{ at: number; seq: number; resolve: () => void }> = [];
  let seq = 0;
  const park = (ms: number) =>
    new Promise<void>((resolve) => {
      timers.push({ at: t + Math.max(0, ms), seq: seq++, resolve });
    });
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return park(ms);
  };
  const base: SettleOptions<string> = {
    now: () => t,
    sleep,
    read: async () => {
      const began = t;
      reads.push(began);
      await park(opts.readMs ?? 200);
      const error = opts.readError?.(began);
      if (error) throw error;
      const signature = (opts.screen ?? (() => "a"))(began);
      return { signature, value: signature };
    },
    ...(opts.frames === null ? {} : { frames: async () => (opts.frames ?? (() => 7))(t) }),
  };
  async function run<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    promise.then(() => { done = true; }, () => { done = true; });
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      if (done) break;
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers.shift();
      if (!next) throw new Error("deadlock: nothing scheduled");
      t = Math.max(t, next.at);
      next.resolve();
    }
    return promise;
  }
  return { base, reads, sleeps, run, now: () => t };
}

/** Counter that ticks every `periodMs` until `untilMs`, then holds. */
const animating = (untilMs: number, periodMs = 16) => (t: number) => Math.floor(Math.min(t, untilMs) / periodMs);

describe("waitForSettle: frames-quiet", () => {
  test("a push transition settles on frames-quiet with ONE AX read", async () => {
    // Frames move for 800 ms (measured on iOS 27 Settings > General).
    const w = world({ frames: animating(800), screen: (t) => (t < 800 ? "root" : "general") });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: true, reason: "frames-quiet", samples: 1, signals: { ax: true, frames: true } });
    expect(result.last).toBe("general");
    // Quiet detected within one poll of 800 + 250, plus the 200 ms read.
    expect(result.waitedMs).toBeGreaterThanOrEqual(1250);
    expect(result.waitedMs).toBeLessThanOrEqual(1300);
    expect(w.reads[0]).toBeGreaterThanOrEqual(1050);
  });

  test("polls frames immediately: no fixed delay before the first poll", async () => {
    const w = world({ frames: () => 1 });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    // Static screen: quiet for 250 ms from the start, then one read.
    expect(result).toMatchObject({ settled: true, reason: "frames-quiet", samples: 1, waitedMs: 450 });
    expect(Math.max(...w.sleeps)).toBeLessThanOrEqual(50);
    expect(result.lastFrames).toBe(1);
  });

  test("never reports settled while frames are still moving", async () => {
    // Never quiet, AX changes every read: no settle until the timeout.
    let n = 0;
    const w = world({ frames: (t) => t, screen: () => String(n++) });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: false, reason: "timeout" });
    expect(result.busy).toContain("frames");
    expect(result.busy).toContain("ax");
  });

  test("a frame during the confirming read rejects it and restarts the quiet window", async () => {
    // Quiet from 0 to 400, one frame at 400 (150 ms into the first read,
    // 250-450), then quiet: the second read waits for 250 ms of quiet.
    const w = world({ frames: (t) => (t < 400 ? 1 : 2) });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: true, reason: "frames-quiet", samples: 2, lastFrames: 2 });
    expect(w.reads[1]).toBeGreaterThanOrEqual(700);
  });

  test("a frame during every confirming read still settles once two reads match", async () => {
    // A tick at 400, 800, 1200, ... lands late inside each read; the tree is static.
    // (The second read's tick is 100 ms in, which also passes as its redraw.)
    const w = world({ frames: (t) => Math.floor(t / 400) });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: true, samples: 2 });
    expect(["ax-quiet", "frames-quiet"]).toContain(result.reason);
  });

  test("a frame during the read with a changed tree waits for frames-quiet again", async () => {
    // Late content load: the tree changes at 400 ms with one frame.
    const w = world({ frames: (t) => (t < 400 ? 1 : 2), screen: (t) => (t < 400 ? "loading" : "loaded") });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: true, reason: "frames-quiet", samples: 2 });
    expect(result.last).toBe("loaded");
  });
});

describe("waitForSettle: the first read's own redraw", () => {
  // Measured on iOS 27: the first AX read of a new screen draws one frame
  // 35-55 ms in; frames then stay still.
  test("one frame early in the confirming read is the read's redraw: frames-quiet, one read", async () => {
    let readStart = -1;
    const w = world({
      frames: (t) => (readStart >= 0 && t >= readStart + 40 ? 2 : 1),
    });
    const read = w.base.read;
    w.base.read = async () => { if (readStart < 0) readStart = w.now(); return read(); };
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: true, reason: "frames-quiet", samples: 1, lastFrames: 2 });
  });

  test("a frame late in the read is the screen changing, not the redraw", async () => {
    // Read 1 runs 250-450; a frame at 400 (150 ms in) must reject it.
    const w = world({ frames: (t) => (t < 400 ? 1 : 2), screen: (t) => (t < 400 ? "old" : "new") });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: true, reason: "frames-quiet", samples: 2 });
    expect(result.last).toBe("new");
  });

  test("several frames early in the read are not a redraw", async () => {
    // Four frames between 260 and 340 (inside the first 120 ms of a 250-450 read).
    const w = world({ frames: (t) => (t < 260 ? 1 : t < 340 ? 1 + Math.floor((t - 240) / 20) : 5) });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result.samples).toBeGreaterThanOrEqual(2);
  });
});

describe("waitForSettle: continuous animation", () => {
  test("a spinner (frames never quiet) settles on ax-quiet after busyFallbackMs", async () => {
    const w = world({ frames: (t) => Math.floor(t / 16) });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: true, reason: "ax-quiet", samples: 2 });
    expect(w.reads[0]).toBeGreaterThanOrEqual(1200);
    expect(result.waitedMs).toBeLessThanOrEqual(1700);
  });

  test("a blinking caret (measured: ~600 ms of changes, ~470 ms gap, 1 s period) terminates", async () => {
    const caret = (t: number) => {
      const cycle = Math.floor(t / 1000);
      const phase = t % 1000;
      return cycle * 10 + Math.min(10, Math.floor(Math.min(phase, 530) / 53));
    };
    const w = world({ frames: caret });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result.settled).toBe(true);
    expect(["frames-quiet", "ax-quiet"]).toContain(result.reason);
    expect(result.waitedMs).toBeLessThan(2000);
  });

  test("a moving tree under continuous frames is not ax-quiet", async () => {
    const w = world({ frames: (t) => t, screen: (t) => String(Math.floor(t / 100)) });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 2500 }));
    expect(result).toMatchObject({ settled: false, reason: "timeout" });
    expect(result.waitedMs).toBeLessThanOrEqual(2500);
  });
});

describe("waitForSettle: no frame counter", () => {
  test("falls back to two identical AX reads", async () => {
    const w = world({ frames: null, screen: (t) => (t < 300 ? "a" : "b") });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: true, reason: "ax-quiet", signals: { frames: false } });
    expect(result.last).toBe("b");
    expect(result.samples).toBe(3); // a, b, b
  });

  test("a counter that returns null or throws counts as unavailable", async () => {
    for (const frames of [async () => null, async () => { throw new Error("capture down"); }]) {
      const w = world({});
      const result = await w.run(waitForSettle({ ...w.base, frames, timeoutMs: 3000 }));
      expect(result).toMatchObject({ settled: true, reason: "ax-quiet", signals: { frames: false }, samples: 2 });
    }
  });
});

describe("waitForSettle: timeout", () => {
  test("the timeout is hard: no read starts that would end past it", async () => {
    let n = 0;
    const w = world({ frames: null, screen: () => String(n++), readMs: 650 });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: false, reason: "timeout", busy: ["ax"] });
    expect(result.waitedMs).toBeLessThanOrEqual(3000);
  });

  test("frames that never stop still yield one read near the deadline so callers get a tree", async () => {
    const w = world({ frames: (t) => t, screen: () => "a" });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 1000, busyFallbackMs: 5000 }));
    expect(result).toMatchObject({ settled: false, reason: "timeout", busy: ["frames"], samples: 1, last: "a" });
    expect(result.waitedMs).toBeLessThanOrEqual(1000);
  });

  test("timeoutMs 0 still returns the current tree", async () => {
    const w = world({ frames: () => 1 });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 0 }));
    expect(result).toMatchObject({ settled: false, reason: "timeout", samples: 1, last: "a" });
  });

  test("read errors surface as lastError on timeout", async () => {
    const w = world({ frames: () => 1, readError: () => new Error("ax unavailable") });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 1000 }));
    expect(result).toMatchObject({ settled: false, reason: "timeout", lastError: "ax unavailable" });
    expect(result.last).toBeUndefined();
  });

  test("a read error is retried and a later good read can settle", async () => {
    const w = world({ frames: () => 1, readError: (t) => (t < 300 ? new Error("blip") : null) });
    const result = await w.run(waitForSettle({ ...w.base, timeoutMs: 3000 }));
    expect(result).toMatchObject({ settled: true, reason: "frames-quiet", samples: 2 });
    expect(result.lastError).toBeUndefined();
  });
});

describe("clampSettleTimeout", () => {
  test("defaults, parses, and clamps to [0, 30000]", () => {
    expect(clampSettleTimeout(undefined)).toBe(3000);
    expect(clampSettleTimeout(null)).toBe(3000);
    expect(clampSettleTimeout("1500")).toBe(1500);
    expect(clampSettleTimeout(250.7)).toBe(251);
    expect(clampSettleTimeout(-5)).toBe(0);
    expect(clampSettleTimeout(99_999)).toBe(30_000);
    expect(clampSettleTimeout("abc")).toBeNull();
    expect(clampSettleTimeout("")).toBe(3000);
  });
});
