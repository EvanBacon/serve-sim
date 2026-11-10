import { describe, expect, test } from "bun:test";
import { clampSettleTimeout, waitForSettle } from "../ax-settle";

type SettleSample<T> = { signature: string; frames: number | null; value: T };

/** Fake clock: `sleep` advances time instantly; `sample` reads a scripted series. */
function harness(series: Array<Partial<SettleSample<string>> | Error>, sampleCostMs = 0) {
  let t = 1000;
  let i = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    sampled: () => i,
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    sample: async (): Promise<SettleSample<string>> => {
      const next = series[Math.min(i, series.length - 1)]!;
      i++;
      t += sampleCostMs;
      if (next instanceof Error) throw next;
      return { signature: next.signature ?? "a", frames: next.frames ?? null, value: next.value ?? next.signature ?? "a" };
    },
  };
}

describe("waitForSettle", () => {
  test("settles once two consecutive samples match (AX-only when frames are unavailable)", async () => {
    const h = harness([{ signature: "a" }, { signature: "a" }]);
    const result = await waitForSettle({ ...h, intervalMs: 200, timeoutMs: 3000 });
    expect(result).toMatchObject({ settled: true, reason: "quiet", waitedMs: 200, samples: 2, signals: { ax: true, frames: false } });
    expect(result.last).toBe("a");
  });

  test("keeps waiting while the AX tree changes, then settles", async () => {
    const h = harness([{ signature: "a" }, { signature: "b" }, { signature: "c" }, { signature: "c" }]);
    const result = await waitForSettle({ ...h, intervalMs: 200, timeoutMs: 3000 });
    expect(result).toMatchObject({ settled: true, reason: "quiet", waitedMs: 600, samples: 4 });
    expect(result.last).toBe("c");
  });

  test("an identical AX tree with new frames is not settled; frames going quiet settles", async () => {
    const h = harness([
      { signature: "a", frames: 1 },
      { signature: "a", frames: 5 },
      { signature: "a", frames: 9 },
      { signature: "a", frames: 9 },
    ]);
    const result = await waitForSettle({ ...h, intervalMs: 200, timeoutMs: 3000 });
    expect(result).toMatchObject({ settled: true, waitedMs: 600, signals: { ax: true, frames: true } });
  });

  test("reports a timeout with what was still busy", async () => {
    let n = 0;
    const h = harness([]);
    const result = await waitForSettle({
      ...h,
      sample: async () => ({ signature: String(n++), frames: null, value: "x" }),
      intervalMs: 200,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ settled: false, reason: "timeout", waitedMs: 1000, busy: ["ax"] });
  });

  test("frames busy while AX is quiet is reported as such on timeout", async () => {
    let f = 0;
    const h = harness([]);
    const result = await waitForSettle({
      ...h,
      sample: async () => ({ signature: "same", frames: f++, value: "x" }),
      intervalMs: 250,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ settled: false, busy: ["frames"] });
  });

  test("never overshoots the hard timeout: a sample predicted to end past it is not started", async () => {
    let n = 0;
    let t = 0;
    const result = await waitForSettle({
      now: () => t,
      sleep: async (ms) => { t += ms; },
      sample: async () => { t += 650; return { signature: String(n++), frames: null, value: "x" }; },
      intervalMs: 200,
      timeoutMs: 3000,
    });
    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeLessThanOrEqual(3000);
    // 650 + (200 + 650) * 2 = 2350; a third interval + sample would end at 3200.
    expect(result.samples).toBe(3);
  });

  test("slow samples can still settle within the timeout", async () => {
    let t = 0;
    const result = await waitForSettle({
      now: () => t,
      sleep: async (ms) => { t += ms; },
      sample: async () => { t += 650; return { signature: "same", frames: 1, value: "x" }; },
      intervalMs: 200,
      timeoutMs: 3000,
    });
    expect(result).toMatchObject({ settled: true, waitedMs: 1500, samples: 2 });
  });

  test("waits initialDelayMs before the first sample so the action can start", async () => {
    const h = harness([{ signature: "a" }, { signature: "a" }]);
    const result = await waitForSettle({ ...h, intervalMs: 200, timeoutMs: 3000, initialDelayMs: 100 });
    expect(h.sleeps[0]).toBe(100);
    expect(result.waitedMs).toBe(300);
  });

  test("sample errors reset the quiet streak and surface as lastError on timeout", async () => {
    const h = harness([new Error("ax unavailable")]);
    const result = await waitForSettle({ ...h, intervalMs: 200, timeoutMs: 600 });
    expect(result).toMatchObject({ settled: false, reason: "timeout", lastError: "ax unavailable" });
    expect(result.last).toBeUndefined();
  });

  test("an error between two matching samples breaks the streak", async () => {
    const h = harness([{ signature: "a" }, new Error("blip"), { signature: "a" }, { signature: "a" }]);
    const result = await waitForSettle({ ...h, intervalMs: 200, timeoutMs: 3000 });
    expect(result).toMatchObject({ settled: true, waitedMs: 600, samples: 4 });
  });

  test("quietSamples controls how many matching samples in a row are required", async () => {
    const h = harness([{ signature: "a" }]);
    const result = await waitForSettle({ ...h, intervalMs: 100, timeoutMs: 3000, quietSamples: 4 });
    expect(result).toMatchObject({ settled: true, waitedMs: 300, samples: 4 });
  });
});

describe("waitForSettle frame pre-wait", () => {
  test("waits for the cheap frame counter to go quiet before spending AX samples", async () => {
    let t = 0;
    const counts = [1, 2, 3, 4, 4, 4, 4, 4, 4, 4, 4];
    let polls = 0;
    let firstSampleAt = -1;
    const result = await waitForSettle({
      now: () => t,
      sleep: async (ms) => { t += ms; },
      frameCounter: async () => counts[Math.min(polls++, counts.length - 1)]!,
      framePollMs: 50,
      frameQuietMs: 150,
      sample: async () => {
        if (firstSampleAt < 0) firstSampleAt = t;
        t += 300;
        return { signature: "a", frames: 4, value: "x" };
      },
      intervalMs: 200,
      timeoutMs: 3000,
    });
    // Counter changes until poll 3 (t=150), then is stable for 150 ms (t=300).
    expect(firstSampleAt).toBe(300);
    expect(result).toMatchObject({ settled: true, samples: 2 });
  });

  test("skips the pre-wait when the counter is unavailable", async () => {
    let t = 0;
    const result = await waitForSettle({
      now: () => t,
      sleep: async (ms) => { t += ms; },
      frameCounter: async () => null,
      sample: async () => ({ signature: "a", frames: null, value: "x" }),
      intervalMs: 200,
      timeoutMs: 3000,
    });
    expect(result).toMatchObject({ settled: true, waitedMs: 200, signals: { frames: false } });
  });

  test("frames that never go quiet time out without any AX sample", async () => {
    let t = 0;
    let f = 0;
    let sampled = 0;
    const result = await waitForSettle({
      now: () => t,
      sleep: async (ms) => { t += ms; },
      frameCounter: async () => f++,
      sample: async () => { sampled++; return { signature: "a", frames: null, value: "x" }; },
      intervalMs: 200,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ settled: false, reason: "timeout", busy: ["frames"], samples: 0 });
    expect(result.waitedMs).toBeLessThanOrEqual(1000);
    expect(sampled).toBe(0);
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
