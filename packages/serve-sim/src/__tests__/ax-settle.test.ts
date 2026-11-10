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

  test("never overshoots the hard timeout, accounting for slow samples", async () => {
    let n = 0;
    let t = 0;
    const result = await waitForSettle({
      now: () => t,
      sleep: async (ms) => { t += ms; },
      sample: async () => { t += 120; return { signature: String(n++), frames: null, value: "x" }; },
      intervalMs: 200,
      timeoutMs: 700,
    });
    expect(result.settled).toBe(false);
    // The last sample may start before the deadline; it is never followed by another sleep.
    expect(result.waitedMs).toBeLessThanOrEqual(700 + 120);
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
