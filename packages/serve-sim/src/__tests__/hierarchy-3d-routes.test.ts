import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { simMiddleware, type ServeSimState } from "../middleware";
import { STATE_DIR, stateFileForDevice } from "../state";
import { agentGet, parseAgentRecord, parseLaunchPid, pickAgent, readAgentRecords, type AgentRecord } from "../hierarchy-3d/agent";
import type { Hierarchy3dDeps } from "../hierarchy-3d/routes";
import type { HierarchyCaptureResponse } from "../hierarchy-3d/model";

delete process.env.SERVE_SIM_AUTH_TOKEN;
(globalThis as Record<string, unknown>).__PREVIEW_HTML_B64__ = Buffer.from(
  "<!doctype html><html><head><!--__SIM_PREVIEW_CONFIG__--></head></html>",
).toString("base64");

const DEVICE = `HIERARCHY-3D-${process.pid}`;
const stateFile = stateFileForDevice(DEVICE);
const TOKEN = "a".repeat(48);

function record(extra: Partial<AgentRecord> = {}): AgentRecord {
  return { pid: 4242, port: 1, token: TOKEN, bundleId: "dev.example", udid: DEVICE, startedAt: 1, ...extra };
}

const agentPayload = {
  protocol: 1,
  captureId: "c3",
  pid: 4242,
  bundleId: "dev.example",
  screen: { width: 402, height: 874, scale: 3 },
  windows: [
    {
      id: "0xabc",
      class: "UIWindow",
      frame: { x: 0, y: 0, width: 402, height: 874 },
      snapshot: { frame: { x: 0, y: 0, width: 402, height: 874 }, bytes: 10 },
      children: [],
    },
  ],
};

function fakeDeps(overrides: Partial<Hierarchy3dDeps> = {}): Partial<Hierarchy3dDeps> {
  return {
    readAgents: () => [record()],
    agentGet: async (_r, path) => {
      if (path.startsWith("/hierarchy")) return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(agentPayload)) };
      if (path === "/snapshot/c3/0xabc.png") return { status: 200, contentType: "image/png", body: Buffer.from("PNGDATA") };
      return { status: 404, contentType: "application/json", body: Buffer.from("{}") };
    },
    frontmost: async () => ({ bundleId: "dev.example", pid: 4242 }),
    describeAx: async () => [{ frame: { x: 0, y: 0, width: 402, height: 874 }, type: "Application", children: [] }],
    screenshot: async () => Buffer.from("SHOT"),
    launchWithAgent: async () => ({ pid: 5000 }),
    waitForAgent: async () => record({ pid: 5000 }),
    pageHtml: () => "<html><!--__SIM_HIERARCHY_3D_CONFIG__--></html>",
    ...overrides,
  };
}

const servers: Server[] = [];
function listen(options: Parameters<typeof simMiddleware>[0]): Promise<string> {
  const middleware = simMiddleware(options);
  const server = createServer((req, res) => {
    middleware(req, res, async () => {
      res.statusCode = 404;
      res.end("host-app");
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

beforeAll(() => {
  mkdirSync(STATE_DIR, { recursive: true });
  const state: ServeSimState = {
    pid: process.pid,
    port: 3100,
    device: DEVICE,
    url: "http://127.0.0.1:3100",
    streamUrl: `http://127.0.0.1:3100/helper/${DEVICE}/stream.mjpeg`,
    wsUrl: `ws://127.0.0.1:3100/helper/${DEVICE}/ws`,
  };
  writeFileSync(stateFile, JSON.stringify(state));
});

afterAll(async () => {
  rmSync(stateFile, { force: true });
  for (const s of servers) s.closeAllConnections();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

describe("hierarchy-3d routes", () => {
  test("don't exist unless experimentalHierarchy3d is set", async () => {
    const origin = await listen({ basePath: "/.sim", device: DEVICE, hierarchy3dDeps: fakeDeps() });
    for (const path of ["/.sim/hierarchy-3d", "/.sim/hierarchy-3d/api/capture"]) {
      const res = await fetch(`${origin}${path}?device=${DEVICE}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("host-app");
    }
  });

  test("serve the page with an injected config", async () => {
    const origin = await listen({ basePath: "/.sim", device: DEVICE, experimentalHierarchy3d: true, hierarchy3dDeps: fakeDeps() });
    const html = await (await fetch(`${origin}/.sim/hierarchy-3d`)).text();
    expect(html).toContain(`window.__SIM_HIERARCHY_3D__={"basePath":"/.sim","device":"${DEVICE}"}`);
  });

  test("capture uses the injected agent of the foreground app and proxies snapshots", async () => {
    const origin = await listen({ basePath: "/.sim", device: DEVICE, experimentalHierarchy3d: true, hierarchy3dDeps: fakeDeps() });
    const body = (await (await fetch(`${origin}/.sim/hierarchy-3d/api/capture?device=${DEVICE}`)).json()) as HierarchyCaptureResponse;
    expect(body.capture?.source).toBe("injected");
    expect(body.notice).toBeUndefined();
    const url = body.capture!.windows[0]!.snapshot!.url;
    expect(url).toBe(`/.sim/hierarchy-3d/api/snapshot?device=${DEVICE}&pid=4242&capture=c3&id=0xabc`);
    const png = await fetch(`${origin}${url}`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(await png.text()).toBe("PNGDATA");
  });

  test("snapshot proxy rejects unknown pids and malformed ids", async () => {
    const origin = await listen({ basePath: "/.sim", device: DEVICE, experimentalHierarchy3d: true, hierarchy3dDeps: fakeDeps() });
    const base = `${origin}/.sim/hierarchy-3d/api/snapshot?device=${DEVICE}`;
    expect((await fetch(`${base}&pid=1&capture=c3&id=0xabc`)).status).toBe(404);
    expect((await fetch(`${base}&pid=4242&capture=c3&id=..%2Fx`)).status).toBe(404);
    expect((await fetch(`${base}&pid=4242&capture=..&id=0xabc`)).status).toBe(404);
  });

  test("falls back to the accessibility tree when the foreground app isn't injected", async () => {
    const origin = await listen({
      basePath: "/.sim", device: DEVICE, experimentalHierarchy3d: true,
      hierarchy3dDeps: fakeDeps({ frontmost: async () => ({ bundleId: "com.apple.Preferences", pid: 77 }) }),
    });
    const body = (await (await fetch(`${origin}/.sim/hierarchy-3d/api/capture?device=${DEVICE}`)).json()) as HierarchyCaptureResponse;
    expect(body.capture?.source).toBe("accessibility");
    expect(body.capture?.screenshotUrl).toStartWith(`/.sim/hierarchy-3d/api/screenshot?device=${DEVICE}`);
    expect(body.notice).toContain("com.apple.Preferences");
    expect(body.canInject).toBe(true);
  });

  test("falls back when the agent errors", async () => {
    const origin = await listen({
      basePath: "/.sim", device: DEVICE, experimentalHierarchy3d: true,
      hierarchy3dDeps: fakeDeps({ agentGet: async () => { throw new Error("ECONNREFUSED"); } }),
    });
    const body = (await (await fetch(`${origin}/.sim/hierarchy-3d/api/capture?device=${DEVICE}`)).json()) as HierarchyCaptureResponse;
    expect(body.capture?.source).toBe("accessibility");
    expect(body.notice).toContain("ECONNREFUSED");
  });

  test("inject validates the bundle id and relaunches", async () => {
    const launched: string[] = [];
    const origin = await listen({
      basePath: "/.sim", device: DEVICE, experimentalHierarchy3d: true,
      hierarchy3dDeps: fakeDeps({ launchWithAgent: async (_u, b) => { launched.push(b); return { pid: 5000 }; } }),
    });
    const post = (bundleId: string) => fetch(`${origin}/.sim/hierarchy-3d/api/inject?device=${DEVICE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId }),
    });
    expect((await post("bad id; rm -rf")).status).toBe(400);
    const ok = await post("dev.example");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, pid: 5000, bundleId: "dev.example" });
    expect(launched).toEqual(["dev.example"]);
  });

  test("inject is refused cross-origin", async () => {
    const origin = await listen({ basePath: "/.sim", device: DEVICE, experimentalHierarchy3d: true, hierarchy3dDeps: fakeDeps() });
    const res = await fetch(`${origin}/.sim/hierarchy-3d/api/inject?device=${DEVICE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify({ bundleId: "dev.example" }),
    });
    expect(res.status).toBe(403);
  });

  test("remote viewers need the auth token and may never relaunch apps", async () => {
    const launched: string[] = [];
    const AUTH = "hierarchy-3d-remote-token";
    const origin = await listen({
      basePath: "/.sim", device: DEVICE, authToken: AUTH, experimentalHierarchy3d: true,
      hierarchy3dDeps: fakeDeps({ launchWithAgent: async (_u, b) => { launched.push(b); return { pid: 5000 }; } }),
    });
    // A proxied hop makes the request remote even though the socket is loopback.
    const remote = { "X-Forwarded-For": "203.0.113.9" };
    const page = await fetch(`${origin}/.sim/hierarchy-3d`, { headers: remote });
    expect(page.status).toBe(401);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).not.toContain("__SIM_HIERARCHY_3D__");
    expect((await fetch(`${origin}/.sim/hierarchy-3d/api/capture?device=${DEVICE}`, { headers: remote })).status).toBe(401);
    expect((await fetch(`${origin}/.sim/hierarchy-3d/api/screenshot?device=${DEVICE}`, { headers: remote })).status).toBe(401);

    const authed = { ...remote, Authorization: `Bearer ${AUTH}` };
    const body = (await (await fetch(`${origin}/.sim/hierarchy-3d/api/capture?device=${DEVICE}`, { headers: authed })).json()) as HierarchyCaptureResponse;
    expect(body.canInject).toBe(false);
    const inject = await fetch(`${origin}/.sim/hierarchy-3d/api/inject?device=${DEVICE}`, {
      method: "POST",
      headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ bundleId: "dev.example" }),
    });
    expect(inject.status).toBe(403);
    expect(launched).toEqual([]);
  });
});

describe("hierarchy agent registry", () => {
  test("parseAgentRecord validates fields", () => {
    expect(parseAgentRecord(JSON.stringify(record()))).toEqual(record());
    expect(parseAgentRecord("not json")).toBeNull();
    expect(parseAgentRecord(JSON.stringify({ ...record(), port: 70000 }))).toBeNull();
    expect(parseAgentRecord(JSON.stringify({ ...record(), token: "short" }))).toBeNull();
    expect(parseAgentRecord(JSON.stringify({ ...record(), pid: -1 }))).toBeNull();
  });

  test("readAgentRecords filters by udid, newest first, and removes dead entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-hier-test-"));
    try {
      writeFileSync(join(dir, "1.json"), JSON.stringify(record({ pid: 1, startedAt: 10 })));
      writeFileSync(join(dir, "2.json"), JSON.stringify(record({ pid: 2, startedAt: 20 })));
      writeFileSync(join(dir, "3.json"), JSON.stringify(record({ pid: 3, udid: "OTHER" })));
      writeFileSync(join(dir, "4.json"), JSON.stringify(record({ pid: 4 })));
      writeFileSync(join(dir, "5.json"), "garbage");
      const alive = (pid: number) => pid !== 4;
      expect(readAgentRecords(DEVICE, dir, alive).map((r) => r.pid)).toEqual([2, 1]);
      expect(existsSync(join(dir, "4.json"))).toBe(false);
      expect(existsSync(join(dir, "5.json"))).toBe(false);
      expect(existsSync(join(dir, "3.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pickAgent prefers the foreground pid, then bundle id", () => {
    const a = record({ pid: 1, bundleId: "a" });
    const b = record({ pid: 2, bundleId: "b" });
    expect(pickAgent([a, b], { bundleId: "b", pid: 2 })).toBe(b);
    expect(pickAgent([a, b], { bundleId: "a", pid: 99 })).toBe(a);
    expect(pickAgent([a, b], { bundleId: "c", pid: 3 })).toBeNull();
    expect(pickAgent([a], null)).toBe(a);
    expect(pickAgent([a, b], null)).toBeNull();
  });

  test("parseLaunchPid reads simctl launch output", () => {
    expect(parseLaunchPid("dev.example: 95148\n")).toBe(95148);
    expect(parseLaunchPid("error")).toBeNull();
  });

  test("agentGet sends the token header", async () => {
    let seen: string | undefined;
    const server = createServer((req, res) => {
      seen = req.headers["x-serve-sim-token"] as string;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    const res = await agentGet(record({ port }), "/info");
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('{"ok":true}');
    expect(seen).toBe(TOKEN);
  });
});
