import { describe, expect, test } from "bun:test";
import { requestMetroReload } from "../client/utils/metro-reload-request";

const respond = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("requestMetroReload", () => {
  test("posts the bundle id", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ sent: true }));
    }) as unknown as typeof fetch;
    expect(await requestMetroReload("/reload?device=A", "com.example.app", { fetchImpl })).toBe("sent");
    expect(seen!.url).toBe("/reload?device=A");
    expect(seen!.init?.method).toBe("POST");
    expect(JSON.parse(String(seen!.init?.body))).toEqual({ bundleId: "com.example.app" });
    expect(seen!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("not-sent when the server sent nothing", async () => {
    expect(await requestMetroReload("/reload", "x", { fetchImpl: respond(200, { sent: false, reason: "no-metro" }) })).toBe("not-sent");
  });

  test("not-sent on error responses and servers without the endpoint", async () => {
    expect(await requestMetroReload("/reload", "x", { fetchImpl: respond(400, { sent: false }) })).toBe("not-sent");
    expect(await requestMetroReload("/reload", "x", { fetchImpl: respond(404, "Not found") })).toBe("not-sent");
  });

  test("not-sent when the request never reaches the server", async () => {
    const fetchImpl = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    expect(await requestMetroReload("/reload", "x", { fetchImpl })).toBe("not-sent");
  });

  test("unknown when the server doesn't answer in time", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await requestMetroReload("/reload", "x", { fetchImpl, timeoutMs: 20 })).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
