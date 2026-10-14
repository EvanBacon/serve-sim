import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import type { AddressInfo, Socket } from "net";
import { simMiddleware, type SimMiddlewareOptions } from "../middleware";
import { registerProxiedPeer } from "../request-trust";

// `/api/diagnostics` lists host paths, installed Xcodes, and processes. Only a
// real loopback peer with no proxy in front may read it: a tunnel or reverse
// proxy connects from loopback but forwards someone else's request, and Host /
// Origin are client-controlled. Exercised through the real middleware.

delete process.env.SERVE_SIM_AUTH_TOKEN;

const DEVICE = "00000000-0000-0000-0000-0000000000DD";
const AUTH_TOKEN = "diagnostics-auth-test-token";
const REMOTE_PEER = "203.0.113.7";
const SPOOFED = { Host: "localhost", Origin: "http://localhost" };

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Probe-free sources so the endpoint answers fast and deterministically. */
function fakeSources(sessions: Record<string, unknown>[] = []) {
  const calls = { host: 0 };
  return {
    calls,
    sources: {
      host: async () => { calls.host++; return { macos: { version: "27.0" } }; },
      device: async (udid: string) => ({ udid, name: "iPhone Duo", state: "Booted" }),
      sessions: async () => sessions,
    },
  };
}

/**
 * Serve the real middleware on 127.0.0.1. With `remotePeer`, each connection
 * is recorded as coming from that address — what the Bun front server does
 * for a non-loopback TCP peer (see registerProxiedPeer).
 */
async function listen(options: SimMiddlewareOptions & Record<string, unknown>, remotePeer?: string): Promise<string> {
  const middleware = simMiddleware({ basePath: "/", device: DEVICE, ...options });
  const server = createServer((req, res) => {
    void middleware(req, res, async () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end("Not found");
    });
  });
  if (remotePeer) {
    server.on("connection", (socket: Socket) => {
      const unregister = registerProxiedPeer(socket.remotePort!, remotePeer);
      socket.on("close", unregister);
    });
  }
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/diagnostics`;
}

describe("/api/diagnostics trust", () => {
  test("non-loopback socket is refused, even with a spoofed localhost Host/Origin", async () => {
    const url = await listen({ diagnostics: { sources: fakeSources().sources } }, REMOTE_PEER);
    const res = await fetch(url, { headers: SPOOFED });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("macos");
  });

  test("non-loopback socket is refused even when it presents the remote auth token", async () => {
    const url = await listen({ authToken: AUTH_TOKEN, diagnostics: { sources: fakeSources().sources } }, REMOTE_PEER);
    const res = await fetch(url, { headers: { ...SPOOFED, Authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("macos");
  });

  const forwarded: Array<[string, Record<string, string>]> = [
    ["X-Forwarded-For loopback hop", { "X-Forwarded-For": "127.0.0.1" }],
    ["X-Forwarded-For remote hop", { "X-Forwarded-For": "203.0.113.9" }],
    ["Forwarded", { Forwarded: "for=203.0.113.9;proto=https" }],
    ["X-Real-IP", { "X-Real-IP": "203.0.113.9" }],
    ["X-Forwarded-Host", { "X-Forwarded-Host": "evil.example" }],
  ];
  for (const [name, headers] of forwarded) {
    test(`loopback socket with ${name} and spoofed localhost Host/Origin is refused`, async () => {
      const url = await listen({ diagnostics: { sources: fakeSources().sources } });
      const res = await fetch(url, { headers: { ...SPOOFED, ...headers } });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("macos");
    });
  }

  test("loopback socket with a rebound (non-loopback) Host is refused", async () => {
    const url = await listen({ diagnostics: { sources: fakeSources().sources } });
    const res = await fetch(url, { headers: { Host: "attacker.example" } });
    expect(res.status).toBe(403);
  });

  test("real loopback gets the bundle and never the exec token", async () => {
    const url = await listen({ execToken: "never-leak-exec-token", diagnostics: { sources: fakeSources().sources } });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).schema_version).toBe(1);
    expect(text).not.toContain("never-leak-exec-token");
  });
});

describe("/api/diagnostics cache and rate limit", () => {
  test("repeat requests within the TTL reuse one collection", async () => {
    const fake = fakeSources();
    const url = await listen({ diagnostics: { sources: fake.sources } });
    const [a, b] = await Promise.all([fetch(url), fetch(url)]);
    const c = await fetch(url);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(fake.calls.host).toBe(1);
  });

  test("a burst beyond the limit gets 429 with Retry-After", async () => {
    const url = await listen({ diagnostics: { sources: fakeSources().sources } });
    const statuses: number[] = [];
    let limited: Response | undefined;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(url);
      statuses.push(res.status);
      if (res.status === 429) limited ??= res;
      else await res.arrayBuffer();
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses).toContain(429);
    expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await limited!.json() as { error: string }).error).toBe("rate_limited");
  }, 60_000);

  test("refused callers do not drain the loopback budget", async () => {
    const middlewareOptions = { diagnostics: { sources: fakeSources().sources } };
    const url = await listen(middlewareOptions);
    for (let i = 0; i < 20; i++) {
      const res = await fetch(url, { headers: { Forwarded: "for=203.0.113.9" } });
      expect(res.status).toBe(403);
    }
    expect((await fetch(url)).status).toBe(200);
  });
});

describe("/api/diagnostics encoder dedupe", () => {
  test("collapses encoder errors and sessions to one entry per codec", async () => {
    const err = (codec: string, error: string, width: number, count: number, first_at: string, last_at: string) =>
      ({ codec, error, width, height: 2853, count, first_at, last_at });
    const session = {
      udid: DEVICE,
      native: {
        encoders: {
          errors: [
            err("AVCC", "encodingFailed: kVTPixelTransferNotSupportedErr (-12905)", 2007, 3, "2026-10-14T10:00:00.000Z", "2026-10-14T10:00:05.000Z"),
            err("AVCC", "encodingFailed: kVTPixelTransferNotSupportedErr (-12905)", 1920, 4, "2026-10-14T09:59:00.000Z", "2026-10-14T10:00:09.000Z"),
            err("MJPEG", "jpegFailed", 2007, 1, "2026-10-14T10:00:01.000Z", "2026-10-14T10:00:01.000Z"),
            err("AVCC", "encodingFailed: kVTVideoEncoderMalfunctionErr (-12911)", 2007, 2, "2026-10-14T10:00:02.000Z", "2026-10-14T10:00:03.000Z"),
          ],
          sessions: [
            { at: "2026-10-14T10:00:00.000Z", codec: "AVCC", width: 2007, height: 2853, status: 0 },
            { at: "2026-10-14T10:00:01.000Z", codec: "MJPEG", width: 2007, height: 2853, status: 0 },
            { at: "2026-10-14T10:00:04.000Z", codec: "AVCC", width: 1920, height: 2853, status: -12905 },
          ],
        },
      },
    };
    const url = await listen({ diagnostics: { sources: fakeSources([session]).sources } });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const bundle = await res.json() as { sessions: Array<{ native: { encoders: { errors: Array<Record<string, unknown>>; sessions: Array<Record<string, unknown>> } } }> };
    const { errors, sessions } = bundle.sessions[0]!.native.encoders;

    expect(errors.map((e) => e.codec).sort()).toEqual(["AVCC", "MJPEG"]);
    const avcc = errors.find((e) => e.codec === "AVCC")!;
    expect(avcc.count).toBe(9);
    expect(avcc.first_at).toBe("2026-10-14T09:59:00.000Z");
    expect(avcc.last_at).toBe("2026-10-14T10:00:09.000Z");
    // The most recent failure describes the codec's current state.
    expect(avcc.width).toBe(1920);
    expect(avcc.error).toBe("encodingFailed: kVTPixelTransferNotSupportedErr (-12905)");
    expect(avcc.variants).toBe(3);

    expect(sessions.map((s) => s.codec).sort()).toEqual(["AVCC", "MJPEG"]);
    const avccSession = sessions.find((s) => s.codec === "AVCC")!;
    expect(avccSession.width).toBe(1920);
    expect(avccSession.session_count).toBe(2);
  });
});
