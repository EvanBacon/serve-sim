import { describe, expect, test } from "bun:test";
import { readStreamError, runStreamWithRetry, streamRetryDelay, type StreamError } from "../client/utils/stream-retry";

describe("stream retry backoff", () => {
  test("doubles from 500 ms and caps at 10 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((attempt) => streamRetryDelay(attempt))).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000]);
  });

  test("reads the 3D renderer 503 body, and falls back for non-JSON bodies", async () => {
    expect(await readStreamError(new Response(JSON.stringify({
      error: "duo_renderer_unavailable", reason: "The selected Xcode does not include the iPhone Duo 3D model.", stage: "model_lookup", details: { model_path: "~/x" },
    }), { status: 503 }))).toEqual({
      status: 503,
      error: "duo_renderer_unavailable",
      reason: "The selected Xcode does not include the iPhone Duo 3D model.",
      stage: "model_lookup",
      details: { model_path: "~/x" },
    });
    expect(await readStreamError(new Response(JSON.stringify({ error: "capture_unavailable", message: "Device not booted" }), { status: 503 })))
      .toMatchObject({ error: "capture_unavailable", reason: "Device not booted" });
    expect(await readStreamError(new Response("Bad Gateway", { status: 502 }))).toEqual({ status: 502, error: "http_502", reason: "Bad Gateway" });
  });

  test("reports each failure with its reason, backs off, and resets after frames flow", async () => {
    const controller = new AbortController();
    const errors: StreamError[] = [];
    const sleeps: number[] = [];
    let opens = 0;
    const chunks: number[] = [];
    const responses: Array<() => Response | Promise<Response>> = [
      () => new Response(JSON.stringify({ error: "duo_renderer_unavailable", reason: "no model", stage: "model_lookup" }), { status: 503 }),
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => new Response(JSON.stringify({ error: "duo_renderer_unavailable", reason: "no model", stage: "model_lookup" }), { status: 503 }),
      () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      () => new Response("{}", { status: 503 }),
    ];
    await runStreamWithRetry({
      url: "http://x/stream.3d.mjpeg?raw=1",
      signal: controller.signal,
      fetch: (async () => {
        const next = responses.shift();
        if (!next) { controller.abort(); throw new DOMException("aborted", "AbortError"); }
        return next();
      }) as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
      connect: () => (chunk) => chunks.push(...chunk),
      onOpen: () => opens++,
      onError: (error) => errors.push(error),
    });
    expect(errors.map((error) => [error.error, error.stage ?? null, error.retryInMs])).toEqual([
      ["duo_renderer_unavailable", "model_lookup", 500],
      ["no_response", null, 1000],
      ["duo_renderer_unavailable", "model_lookup", 2000],
      ["stream_ended", null, 500],
      ["http_503", null, 1000],
    ]);
    expect(errors[1]!.reason).toContain("Failed to fetch");
    expect(sleeps).toEqual([500, 1000, 2000, 500, 1000]);
    expect(opens).toBe(1);
    expect(chunks).toEqual([1, 2, 3]);
  });
});
