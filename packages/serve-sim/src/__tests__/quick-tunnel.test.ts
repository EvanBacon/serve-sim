import { describe, expect, test } from "bun:test";
import type { IncomingMessage } from "http";
import {
  authorizeTunnelRequest,
  createTunnelAccessToken,
  createQuickTunnelLaunchConfig,
  detachedTunnelStartupTimeoutMs,
  extractQuickTunnelUrl,
  quickTunnelLaunchMatches,
  quickTunnelMatchesDeviceStates,
  stopDetachedProcessGroup,
} from "../quick-tunnel";

const TOKEN = "a".repeat(43);
const PUBLIC_HOST = "preview-name.trycloudflare.com";

function request(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Pick<IncomingMessage, "method" | "url" | "headers"> {
  return {
    method: init.method ?? "GET",
    url,
    headers: {
      host: PUBLIC_HOST,
      "x-forwarded-proto": "https",
      ...init.headers,
    },
  };
}

describe("Quick Tunnel access gate", () => {
  test("creates a 256-bit URL-safe access token", () => {
    const token = createTunnelAccessToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("exchanges the private launch token for a secure host-only cookie", () => {
    const decision = authorizeTunnelRequest(
      request(`/?device=DEVICE-A&token=${TOKEN}`),
      TOKEN,
    );

    expect(decision).toMatchObject({
      type: "redirect",
      status: 302,
      location: "/?device=DEVICE-A",
    });
    if (decision.type !== "redirect") throw new Error("expected redirect");
    expect(decision.cookie).toContain(`serve_sim_access=${TOKEN}`);
    expect(decision.cookie).toContain("HttpOnly");
    expect(decision.cookie).toContain("SameSite=Strict");
    expect(decision.cookie).toContain("Secure");
    expect(decision.cookie).not.toContain("Domain=");
  });

  test("accepts the access cookie for same-origin requests", () => {
    const decision = authorizeTunnelRequest(
      request("/grid/api/start", {
        method: "POST",
        headers: {
          cookie: `serve_sim_access=${TOKEN}`,
          origin: `https://${PUBLIC_HOST}`,
        },
      }),
      TOKEN,
    );

    expect(decision).toEqual({ type: "allow" });
  });

  test("rejects missing credentials", () => {
    expect(authorizeTunnelRequest(request("/"), TOKEN)).toMatchObject({
      type: "deny",
      status: 401,
    });
  });

  test("rejects a sibling trycloudflare origin even with the cookie", () => {
    expect(authorizeTunnelRequest(
      request("/exec-ws", {
        headers: {
          cookie: `serve_sim_access=${TOKEN}`,
          origin: "https://attacker.trycloudflare.com",
        },
      }),
      TOKEN,
      { allowTokenExchange: false },
    )).toMatchObject({ type: "deny", status: 403 });
  });

  test("does not exchange query tokens during WebSocket upgrades", () => {
    expect(authorizeTunnelRequest(
      request(`/exec-ws?token=${TOKEN}`),
      TOKEN,
      { allowTokenExchange: false },
    )).toMatchObject({ type: "deny", status: 401 });
  });

  test("allows credential-free loopback HTTP requests from local CLI state URLs", () => {
    expect(authorizeTunnelRequest({
      method: "GET",
      url: "/api/event-log",
      headers: { host: "127.0.0.1:3200" },
    }, TOKEN, { allowLoopback: true })).toEqual({ type: "allow" });
  });

  test("allows credential-free loopback WebSocket upgrades from local CLI state URLs", () => {
    expect(authorizeTunnelRequest({
      method: "GET",
      url: "/helper/DEVICE-A/ws",
      headers: { host: "localhost:3200" },
    }, TOKEN, {
      allowLoopback: true,
      allowTokenExchange: false,
    })).toEqual({ type: "allow" });
  });

  test("does not treat forwarded public requests as loopback", () => {
    expect(authorizeTunnelRequest({
      method: "GET",
      url: "/",
      headers: {
        host: "127.0.0.1:3200",
        "x-forwarded-proto": "https",
      },
    }, TOKEN, { allowLoopback: true })).toMatchObject({
      type: "deny",
      status: 401,
    });
  });
});

describe("Quick Tunnel URL parsing", () => {
  test("extracts a trycloudflare URL from cloudflared output", () => {
    expect(extractQuickTunnelUrl(
      "INF Your quick Tunnel has been created! Visit it at https://one-two-three.trycloudflare.com",
    )).toBe("https://one-two-three.trycloudflare.com");
  });

  test("ignores unrelated URLs", () => {
    expect(extractQuickTunnelUrl("INF Metrics server listening on 127.0.0.1:20241"))
      .toBeNull();
  });
});

describe("Quick Tunnel process ownership", () => {
  const tunnel = {
    ownerPid: 123,
    cloudflaredPid: 456,
    port: 3200,
    publicUrl: `https://${PUBLIC_HOST}/?token=${TOKEN}`,
    localUrl: `http://localhost:3200/?token=${TOKEN}`,
    logFile: "/tmp/serve-sim/tunnel.log",
    devices: ["DEVICE-A"],
    startedAt: "2026-07-20T00:00:00.000Z",
  };

  test("accepts an owner matching current device state", () => {
    expect(quickTunnelMatchesDeviceStates(tunnel, [{
      pid: 123,
      port: 3200,
      device: "DEVICE-A",
      url: "http://127.0.0.1:3200",
      streamUrl: "http://127.0.0.1:3200/helper/DEVICE-A/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:3200/helper/DEVICE-A/ws",
    }])).toBe(true);
  });

  test("rejects stale or reused owner PIDs", () => {
    expect(quickTunnelMatchesDeviceStates(tunnel, [{
      pid: 999,
      port: 3200,
      device: "DEVICE-A",
      url: "http://127.0.0.1:3200",
      streamUrl: "http://127.0.0.1:3200/helper/DEVICE-A/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:3200/helper/DEVICE-A/ws",
    }])).toBe(false);
  });

  test("rejects partially stale multi-device ownership", () => {
    expect(quickTunnelMatchesDeviceStates({
      ...tunnel,
      devices: ["DEVICE-A", "DEVICE-B"],
    }, [{
      pid: 123,
      port: 3200,
      device: "DEVICE-A",
      url: "http://127.0.0.1:3200",
      streamUrl: "http://127.0.0.1:3200/helper/DEVICE-A/stream.mjpeg",
      wsUrl: "ws://127.0.0.1:3200/helper/DEVICE-A/ws",
    }])).toBe(false);
  });
});

describe("Quick Tunnel detached launch identity", () => {
  const launch = createQuickTunnelLaunchConfig({
    devices: ["DEVICE-A"],
    port: 3200,
    portExplicit: false,
    codec: "mjpeg",
    panes: ["devices", "tools"],
    fit: true,
    theme: "dark",
  });

  test("matches an identical request", () => {
    expect(quickTunnelLaunchMatches({ launch }, launch)).toBe(true);
  });

  test.each([
    ["device", { devices: ["DEVICE-B"] }],
    ["port", { port: 3300 }],
    ["explicit port", { portExplicit: true }],
    ["codec", { codec: "auto" }],
    ["panes", { panes: ["devices"] }],
    ["fit", { fit: false }],
    ["theme", { theme: "light" }],
  ])("rejects a different %s request", (_name, change) => {
    const requested = createQuickTunnelLaunchConfig({ ...launch, ...change });
    expect(quickTunnelLaunchMatches({ launch }, requested)).toBe(false);
  });

  test("does not reuse legacy state without a launch signature", () => {
    expect(quickTunnelLaunchMatches({}, launch)).toBe(false);
  });
});

describe("Quick Tunnel detached startup lifecycle", () => {
  test("budgets every simulator boot plus Cloudflare readiness", () => {
    expect(detachedTunnelStartupTimeoutMs(1)).toBeGreaterThanOrEqual(90_000);
    expect(detachedTunnelStartupTimeoutMs(2) - detachedTunnelStartupTimeoutMs(1))
      .toBeGreaterThanOrEqual(60_000);
  });

  test("terminates the detached process group, not only the launcher child", () => {
    const calls: Array<[number, NodeJS.Signals | number]> = [];
    stopDetachedProcessGroup(4321, "SIGTERM", (pid, signal) => {
      calls.push([pid, signal]);
      return true;
    });
    expect(calls).toEqual([[-4321, "SIGTERM"]]);
  });

  test("falls back to the direct PID when group signalling fails", () => {
    const calls: number[] = [];
    stopDetachedProcessGroup(4321, "SIGTERM", (pid) => {
      calls.push(pid);
      if (pid < 0) throw new Error("missing group");
      return true;
    });
    expect(calls).toEqual([-4321, 4321]);
  });
});
