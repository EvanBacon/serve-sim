import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import { MetricsSampler, createMetricsSamplerCache } from "../cpu-mem-sampler";
import { handleMetricsRequest } from "../middleware";
import { inProcessServeSimState } from "../state";

/**
 * Unit tests for the `/metrics` route handler. These exercise the route's own
 * contract with a fake req/res and a sampler cache backed by a controllable
 * sampler, so they run without a booted simulator or shelling out to `ps`.
 * The end-to-end wiring against a real device lives in metrics-endpoint.test.ts.
 */

function createFakeReq(): { req: IncomingMessage; close: () => void } {
  const req = Object.assign(new EventEmitter(), { headers: {} });
  return { req: req as unknown as IncomingMessage, close: () => req.emit("close") };
}

function createFakeRes(): {
  res: ServerResponse;
  writes: string[];
  status: () => number;
  ended: () => boolean;
} {
  const writes: string[] = [];
  let statusCode = 0;
  let ended = false;
  const res = {
    writeHead(status: number) {
      statusCode = status;
      return res;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) writes.push(chunk);
      ended = true;
      return res;
    },
    get writableEnded() {
      return ended;
    },
  };
  return { res: res as unknown as ServerResponse, writes, status: () => statusCode, ended: () => ended };
}

// A cache whose samplers never fire on their own timer (huge interval); the
// test drives emission explicitly via `created[i].tickOnce()`.
function createTrackingCache() {
  const created: MetricsSampler[] = [];
  const cache = createMetricsSamplerCache((udid) => {
    const sampler = new MetricsSampler({
      udid,
      intervalMs: 1_000_000,
      now: () => 0,
      hostCores: 8,
      sample: async () => ({ bundleId: "com.example.app", cpuSeconds: 1, memBytes: 2048 }),
    });
    created.push(sampler);
    return sampler;
  });
  return { cache, created };
}

function sampleFrames(writes: string[]): string[] {
  return writes.filter((w) => w.startsWith("data:"));
}

function firstSampler(created: MetricsSampler[]): MetricsSampler {
  const sampler = created[0];
  if (!sampler) throw new Error("expected a sampler to have been created");
  return sampler;
}

describe("handleMetricsRequest", () => {
  test("responds 404 for an unknown device without opening a sampler", () => {
    const { cache, created } = createTrackingCache();
    const { req } = createFakeReq();
    const { res, status } = createFakeRes();

    handleMetricsRequest(req, res, null, cache);

    expect(status()).toBe(404);
    expect(created).toHaveLength(0);
  });

  test("writes the meta frame before any sample", async () => {
    const { cache, created } = createTrackingCache();
    const { req } = createFakeReq();
    const { res, writes } = createFakeRes();

    handleMetricsRequest(req, res, inProcessServeSimState("UDID-1", 4000), cache);

    const metaFrame = writes[1] ?? "";
    expect(metaFrame).toStartWith("event: meta\ndata:");
    const meta = JSON.parse(metaFrame.slice("event: meta\ndata:".length).trim());
    expect("t" in meta).toBe(false);
    expect(sampleFrames(writes)).toHaveLength(0);

    await firstSampler(created).tickOnce();
    expect(sampleFrames(writes)).toHaveLength(1);

    created.forEach((s) => s.stop());
  });

  test("shares one sampler across concurrent subscribers to the same device", async () => {
    const { cache, created } = createTrackingCache();
    const state = inProcessServeSimState("UDID-1", 4000);
    const a = createFakeReq();
    const b = createFakeReq();
    const resA = createFakeRes();
    const resB = createFakeRes();

    handleMetricsRequest(a.req, resA.res, state, cache);
    handleMetricsRequest(b.req, resB.res, state, cache);

    expect(created).toHaveLength(1);

    await firstSampler(created).tickOnce();
    expect(sampleFrames(resA.writes)).toEqual(sampleFrames(resB.writes));
    expect(sampleFrames(resA.writes)).toHaveLength(1);

    created.forEach((s) => s.stop());
  });

  test("stops the sampler only after the last client disconnects", async () => {
    const { cache, created } = createTrackingCache();
    const state = inProcessServeSimState("UDID-1", 4000);
    const a = createFakeReq();
    const b = createFakeReq();

    handleMetricsRequest(a.req, createFakeRes().res, state, cache);
    handleMetricsRequest(b.req, createFakeRes().res, state, cache);
    expect(created).toHaveLength(1);

    a.close();
    expect(firstSampler(created).listenerCount).toBe(1);

    b.close();
    expect(firstSampler(created).listenerCount).toBe(0);

    // With the shared sampler evicted, a fresh subscriber builds a new one.
    handleMetricsRequest(createFakeReq().req, createFakeRes().res, state, cache);
    expect(created).toHaveLength(2);

    created.forEach((s) => s.stop());
  });
});
