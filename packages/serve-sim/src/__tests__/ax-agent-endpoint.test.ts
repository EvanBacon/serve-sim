import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { RawAxeNode } from "../ax";
import { AX_AGENT_ENDPOINTS } from "../ax-agent-http";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";

/**
 * Endpoint tests for /ax/snapshot, /ax/act and /ax/settle on a DeviceSession
 * with fake native capture/HID/AX (no simulator), mounted the way the
 * middleware's serveHelperInProcess routes them.
 */

const servers: Server[] = [];
const sessions: DeviceSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

const SCREEN = { x: 0, y: 0, width: 402, height: 874 };

function node(label: string, y: number, overrides: Partial<RawAxeNode> = {}): RawAxeNode {
  return {
    AXUniqueId: null,
    AXLabel: label,
    AXValue: null,
    enabled: true,
    frame: { x: 0, y, width: 402, height: 52 },
    role_description: "button",
    type: "Button",
    children: [],
    ...overrides,
  };
}

const tree = (...children: RawAxeNode[]): RawAxeNode[] => [
  { ...node("", 0), AXLabel: null, frame: SCREEN, type: "Application", role_description: "application", children },
];

const HOME = tree(node("Settings", 60, { type: "Heading", role_description: "heading" }), node("General", 300), node("Privacy", 360));
const GENERAL = tree(node("Back", 60), node("About", 300));

type Touch = { type: string; x: number; y: number; w: number; h: number };

function fakeDeps(screens: { current: RawAxeNode[] }, touches: Touch[], contentFrames = 7): DeviceSessionDependencies {
  return {
    capture: {
      start: async () => {},
      stop: async () => {},
      subscribeMjpeg: async () => () => {},
      subscribeAvcc: async () => () => {},
      subscribeSize: async (cb) => { void cb({ width: 1206, height: 2622 }); return () => {}; },
      snapshotJpeg: async () => null,
      setPreferredScreenSize: async () => {},
      contentChangeCount: () => contentFrames,
      // Settle must poll the counter, never the doctor payload.
      diagnostics: async () => { throw new Error("settle polled diagnostics()"); },
    },
    hid: {
      touch: async (type, x, y, w, h) => {
        touches.push({ type, x, y, w, h });
        if (type === "end" && screens.current === HOME) screens.current = GENERAL;
      },
      multiTouch: async () => {},
      button: async () => {},
      buttonHid: async () => {},
      key: async () => {},
      scroll: async () => {},
      digitalCrown: async () => {},
      orientation: async () => false,
      memoryWarning: async () => {},
      softwareKeyboard: async () => {},
      caDebug: async () => false,
      hardwareKeyboard: async () => false,
      pose: async () => false,
      hinge: async () => false,
    },
    axDescribe: async () => JSON.stringify(screens.current),
  };
}

async function serve(session: DeviceSession): Promise<string> {
  sessions.push(session);
  await session.start();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const endpoint = AX_AGENT_ENDPOINTS[path];
    if (endpoint) void session.handleAxAgent(req, res, endpoint);
    else { res.writeHead(404); res.end(); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function act(base: string, body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) {
  return fetch(`${base}/ax/act`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("GET /ax/snapshot", () => {
  test("returns compact nodes with refs and the screen in points", async () => {
    const base = await serve(new DeviceSession("UDID-AX", fakeDeps({ current: HOME }, [])));
    const res = await fetch(`${base}/ax/snapshot`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as { screen: unknown; nodes: Array<{ ref: string; label: string; center: unknown }> };
    expect(body.screen).toEqual({ width: 402, height: 874 });
    expect(body.nodes.map((n) => `${n.ref} ${n.label}`)).toEqual(["@e1 Settings", "@e2 General", "@e3 Privacy"]);
    expect(body.nodes[1]!.center).toEqual({ x: 201, y: 326 });
  });

  test("?all=1 includes offscreen elements", async () => {
    const screens = { current: tree(node("Top", 10), node("Far", 2000)) };
    const base = await serve(new DeviceSession("UDID-AX", fakeDeps(screens, [])));
    const visible = await (await fetch(`${base}/ax/snapshot`)).json() as { nodes: unknown[] };
    expect(visible.nodes).toHaveLength(1);
    const all = await (await fetch(`${base}/ax/snapshot?all=1`)).json() as { nodes: Array<{ label: string; offscreen?: boolean }> };
    expect(all.nodes.map((n) => [n.label, n.offscreen ?? false])).toEqual([["Top", false], ["Far", true]]);
  });

  test("503 when the AX bridge is unavailable", async () => {
    const deps = fakeDeps({ current: HOME }, []);
    deps.axDescribe = async () => { throw new Error("AX framework missing"); };
    const base = await serve(new DeviceSession("UDID-AX", deps));
    const res = await fetch(`${base}/ax/snapshot`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "ax_unavailable" });
  });

  test("rejects non-GET methods", async () => {
    const base = await serve(new DeviceSession("UDID-AX", fakeDeps({ current: HOME }, [])));
    const res = await fetch(`${base}/ax/snapshot`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  test("HEAD on /ax/snapshot and /ax/settle does no work and leaves the ref session alone", async () => {
    const deps = fakeDeps({ current: HOME }, []);
    let describes = 0;
    const original = deps.axDescribe!;
    deps.axDescribe = async (udid) => { describes++; return original(udid); };
    const base = await serve(new DeviceSession("UDID-AX", deps));
    for (const path of ["/ax/snapshot", "/ax/settle"]) {
      const res = await fetch(`${base}${path}`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    }
    expect(describes).toBe(0);
    // No snapshot was recorded, so a ref is still unknown to the session.
    const act = await fetch(`${base}/ax/act`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: "@e1" }) });
    expect(act.status).toBe(409);
    expect(await act.json()).toMatchObject({ error: "no_snapshot" });
  });
});

describe("POST /ax/act", () => {
  test("taps the element center via HID and, with settle, returns the diff to the new screen", async () => {
    const touches: Touch[] = [];
    const screens = { current: HOME };
    const base = await serve(new DeviceSession("UDID-AX", fakeDeps(screens, touches)));
    await fetch(`${base}/ax/snapshot`);
    const res = await act(base, { ref: "@e2", settle: true, timeoutMs: 2000 });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; ref: string; action: string;
      settle: { settled: boolean; signals: { frames: boolean } };
      diff: { added: Array<{ ref: string; label: string }>; removed: Array<{ label: string }> };
    };
    expect(body).toMatchObject({ ok: true, action: "tap", ref: "@e2" });
    expect(body.settle).toMatchObject({ settled: true, signals: { ax: true, frames: true } });
    expect(body.diff.added.map((n) => `${n.ref} ${n.label}`)).toEqual(["@e4 Back", "@e5 About"]);
    expect(body.diff.removed.map((n) => n.label)).toEqual(["Settings", "General", "Privacy"]);
    // begin + end at General's center, normalized, with the capture's pixel size.
    expect(touches.map((t) => t.type)).toEqual(["begin", "end"]);
    expect(touches[0]!.x).toBeCloseTo(0.5);
    expect(touches[0]!.y).toBeCloseTo(326 / 874);
    expect(touches[0]!.w).toBe(1206);
  });

  test("a stale ref fails loudly with 409 and does not tap", async () => {
    const touches: Touch[] = [];
    const base = await serve(new DeviceSession("UDID-AX", fakeDeps({ current: HOME }, touches)));
    await fetch(`${base}/ax/snapshot`);
    await act(base, { ref: "@e2", settle: true, timeoutMs: 1000 });
    touches.length = 0;
    const res = await act(base, { ref: "@e2" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("stale_ref");
    expect(body.message).toContain("stale");
    expect(body.message).toContain("serve-sim ax --refs");
    expect(touches).toEqual([]);
  });

  test("unknown refs are 404 and acting before any snapshot is 409", async () => {
    const base = await serve(new DeviceSession("UDID-AX", fakeDeps({ current: HOME }, [])));
    expect((await act(base, { ref: "@e1" })).status).toBe(409);
    await fetch(`${base}/ax/snapshot`);
    const res = await act(base, { ref: "@e77" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "unknown_ref" });
  });

  test("requires POST with a JSON body", async () => {
    const base = await serve(new DeviceSession("UDID-AX", fakeDeps({ current: HOME }, [])));
    expect((await fetch(`${base}/ax/act`)).status).toBe(405);
    expect((await act(base, { ref: "@e1" }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await act(base, "{not json")).status).toBe(400);
    expect((await act(base, "x".repeat(20_000))).status).toBe(413);
  });
});

describe("GET /ax/settle", () => {
  test("returns the settle report and the diff vs the last snapshot", async () => {
    const screens = { current: HOME };
    const base = await serve(new DeviceSession("UDID-AX", fakeDeps(screens, [])));
    await fetch(`${base}/ax/snapshot`);
    screens.current = GENERAL;
    const res = await fetch(`${base}/ax/settle?timeoutMs=1500`);
    expect(res.status).toBe(200);
    const body = await res.json() as { settle: { settled: boolean; waitedMs: number }; diff: { added: Array<{ label: string }> } };
    expect(body.settle.settled).toBe(true);
    expect(body.settle.waitedMs).toBeLessThan(1500);
    expect(body.diff.added.map((n) => n.label)).toEqual(["Back", "About"]);
  });

  test("400 for a non-numeric timeout", async () => {
    const base = await serve(new DeviceSession("UDID-AX", fakeDeps({ current: HOME }, [])));
    expect((await fetch(`${base}/ax/settle?timeoutMs=soon`)).status).toBe(400);
  });
});
