import { describe, expect, test } from "bun:test";
import {
  createStaleEpisode,
  createStreamReadStats,
  noteStreamChunk,
  noteStreamFrame,
  streamStaleReport,
} from "../client/utils/stream-stale-diagnostics";
import { createMjpegFrameParser } from "../client/utils/mjpeg-frame-parser";
import { runStreamWithRetry } from "../client/utils/stream-retry";

describe("stale-stream episode", () => {
  test("warns once per episode and re-arms on the next frame", () => {
    const warnings: Array<[string, Record<string, unknown>]> = [];
    const episode = createStaleEpisode((message, details) => warnings.push([message, details]));
    let built = 0;
    const details = () => ({ n: ++built });

    expect(episode.stale(details)).toBe(true);
    expect(episode.stale(details)).toBe(false);
    expect(episode.stale(details)).toBe(false);
    expect(warnings).toEqual([["[serve-sim] stream stale", { n: 1 }]]);
    // Details are only built for the warning that fires.
    expect(built).toBe(1);

    episode.frame();
    expect(episode.stale(details)).toBe(true);
    expect(warnings).toHaveLength(2);
  });

  test("a frame without a stale episode does not warn", () => {
    const warnings: unknown[] = [];
    const episode = createStaleEpisode((...args) => warnings.push(args));
    episode.frame();
    episode.frame();
    expect(warnings).toEqual([]);
  });
});

describe("stale-stream report", () => {
  test("reports ages, counters, read state and visibility", () => {
    const stats = createStreamReadStats();
    noteStreamChunk(stats, 1000, 10_000);
    noteStreamChunk(stats, 500, 11_000);
    noteStreamFrame(stats, 10_500);
    stats.bufferedBytes = 500;
    stats.readPending = true;
    stats.connections = 1;
    expect(streamStaleReport({ path: "mjpeg-js", stats, lastViewFrameAt: 10_400, hidden: false, now: 14_000 })).toEqual({
      path: "mjpeg-js",
      msSinceLastChunk: 3000,
      msSinceLastFrame: 3500,
      msSinceLastViewFrame: 3600,
      bytes: 1500,
      frames: 1,
      bufferedBytes: 500,
      readPending: true,
      connections: 1,
      hidden: false,
    });
  });

  test("without reader stats only the view's frame age is known", () => {
    expect(streamStaleReport({ path: "mjpeg-js", lastViewFrameAt: 1000, hidden: true, now: 4000 })).toEqual({
      path: "mjpeg-js",
      msSinceLastChunk: null,
      msSinceLastFrame: 3000,
      msSinceLastViewFrame: 3000,
      bytes: null,
      frames: null,
      bufferedBytes: null,
      readPending: null,
      connections: null,
      hidden: true,
    });
  });
});

describe("reader stats", () => {
  test("the MJPEG parser reports bytes held without a complete frame", () => {
    const frames: number[] = [];
    const parser = createMjpegFrameParser((jpeg) => frames.push(jpeg.length));
    const part = new TextEncoder().encode("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n");
    parser.push(part);
    expect(parser.buffered()).toBe(part.length);
    parser.push(new Uint8Array([0xff, 0xd8]));
    expect(parser.buffered()).toBe(part.length + 2);
    parser.push(new Uint8Array([0xff, 0xd9]));
    expect(frames).toEqual([4]);
    expect(parser.buffered()).toBe(0);
  });

  test("runStreamWithRetry counts bytes and connections and flags a pending read", async () => {
    const controller = new AbortController();
    const stats = createStreamReadStats();
    let push!: (chunk: Uint8Array) => void;
    let fail!: (error: unknown) => void;
    const body = new ReadableStream<Uint8Array>({ start(c) { push = (chunk) => c.enqueue(chunk); fail = (e) => c.error(e); } });
    let fetches = 0;
    const done = runStreamWithRetry({
      url: "http://x/stream.mjpeg?raw=1",
      signal: controller.signal,
      stats,
      fetch: (async (_url: string, init?: RequestInit) => {
        if (fetches++ > 0) throw new DOMException("aborted", "AbortError");
        init?.signal?.addEventListener("abort", () => fail(new DOMException("aborted", "AbortError")));
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch,
      sleep: async () => {},
      connect: () => () => {},
      onError: () => {},
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    expect(stats.connections).toBe(1);
    expect(stats.readPending).toBe(true);
    expect(stats.bytes).toBe(0);
    expect(stats.lastChunkAt).toBe(0);

    const before = Date.now();
    push(new Uint8Array(3));
    push(new Uint8Array(7));
    await tick();
    expect(stats.bytes).toBe(10);
    expect(stats.lastChunkAt).toBeGreaterThanOrEqual(before);
    // Back to waiting on the (now silent) connection.
    expect(stats.readPending).toBe(true);

    controller.abort();
    await done;
    expect(stats.readPending).toBe(false);
  });
});
