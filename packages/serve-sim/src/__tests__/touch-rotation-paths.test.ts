import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { join } from "path";
import { WebSocketServer } from "ws";
import type { RawAxeNode } from "../ax";
import { AX_AGENT_ENDPOINTS } from "../ax-agent-http";
import type { DuoState } from "../duo-state";
import { DeviceSession, type DeviceSessionDependencies } from "../device-session";

// #153: `SimHID.touch` reads x/y in the device's native portrait frame even
// after the UI rotates. Two host paths turn a display-space point into that
// raw frame on their own: the CLI (`serve-sim tap` / `gesture`, from /config)
// and the server (`/ax/act` → DeviceSession.injectTap, from its own screen
// config). A new iOS release that changes how either path learns the
// orientation would silently land landscape taps on the wrong element, so
// both are driven end to end here for all four orientations, against the
// same hard-coded expectations (not the shared mapping function).

type Orientation = "portrait" | "landscape_left" | "landscape_right" | "portrait_upside_down";

// Display point (0.7, 0.2) and where it must land in the raw portrait frame.
const DISPLAY = { x: 0.7, y: 0.2 };
const EXPECTED_RAW: Record<Orientation, { x: number; y: number }> = {
  portrait: { x: 0.7, y: 0.2 },
  landscape_left: { x: 0.2, y: 0.3 },
  landscape_right: { x: 0.8, y: 0.7 },
  portrait_upside_down: { x: 0.3, y: 0.8 },
};
// A bottom-edge swipe (HID edge 3) must come from the raw edge facing the user's bottom.
const EXPECTED_EDGE_FOR_BOTTOM: Record<Orientation, number> = {
  portrait: 3,
  landscape_left: 4,
  landscape_right: 1,
  portrait_upside_down: 2,
};
const ORIENTATIONS = Object.keys(EXPECTED_RAW) as Orientation[];

// iPhone 17 Pro capture: the buffer stays portrait after the UI rotates.
const RAW_W = 1206;
const RAW_H = 2622;

type Touch = { type: string; x: number; y: number; edge?: number };

function expectRaw(touch: Touch | undefined, orientation: Orientation) {
  expect(touch).toBeDefined();
  expect(touch!.x).toBeCloseTo(EXPECTED_RAW[orientation].x, 6);
  expect(touch!.y).toBeCloseTo(EXPECTED_RAW[orientation].y, 6);
}

// ── CLI: serve-sim tap / gesture against a fake remote preview ──────────────

describe("CLI tap/gesture remap display coords for every orientation (#153)", () => {
  const DEVICE = "TOUCH-ROTATION-CLI";
  const cli = join(import.meta.dir, "..", "index.ts");
  let server: Server;
  let base = "";
  let config: Record<string, unknown> = {};
  const touches: Touch[] = [];

  beforeAll(async () => {
    const wss = new WebSocketServer({ noServer: true });
    server = createServer((req, res) => {
      if (req.url?.startsWith("/api")) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ device: DEVICE }));
        return;
      }
      if (req.url === `/helper/${DEVICE}/config`) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(config));
        return;
      }
      res.writeHead(404).end();
    });
    server.on("upgrade", (req, socket, head) => {
      if (req.url !== `/helper/${DEVICE}/ws`) return void socket.destroy();
      wss.handleUpgrade(req, socket, head, (ws) =>
        ws.on("message", (data) => {
          const buf = Buffer.from(data as Buffer);
          if (buf[0] === 0x03) touches.push(JSON.parse(buf.subarray(1).toString("utf8")));
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());
  beforeEach(() => { touches.length = 0; });

  function runCli(args: string[]): Promise<{ status: number | null; stderr: string }> {
    const env = { ...process.env };
    delete env.SERVE_SIM_URL;
    delete env.SERVE_SIM_AUTH_TOKEN;
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["run", cli, ...args, "--url", base, "-d", DEVICE], { env });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stderr });
      });
    });
  }

  for (const orientation of ORIENTATIONS) {
    test(`tap in ${orientation} sends begin/end at the raw portrait point`, async () => {
      config = { width: RAW_W, height: RAW_H, orientation };
      const r = await runCli(["tap", String(DISPLAY.x), String(DISPLAY.y)]);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(touches.map((t) => t.type)).toEqual(["begin", "end"]);
      expectRaw(touches[0], orientation);
      expectRaw(touches[1], orientation);
    }, 25_000);

    test(`gesture in ${orientation} remaps the point and the bottom-edge hint`, async () => {
      config = { width: RAW_W, height: RAW_H, orientation };
      const r = await runCli(["gesture", JSON.stringify({ type: "begin", ...DISPLAY, edge: 3 })]);
      expect(r.status).toBe(0);
      expect(touches).toHaveLength(1);
      expectRaw(touches[0], orientation);
      expect(touches[0]!.edge).toBe(EXPECTED_EDGE_FOR_BOTTOM[orientation]);
    }, 25_000);
  }

  test("a capture that already rotated to landscape is not rotated a second time", async () => {
    config = { width: RAW_H, height: RAW_W, orientation: "landscape_left" };
    const r = await runCli(["tap", String(DISPLAY.x), String(DISPLAY.y)]);
    expect(r.status).toBe(0);
    expect(touches[0]).toMatchObject({ type: "begin", ...DISPLAY });
  }, 25_000);
});

// ── Server: /ax/act → DeviceSession.injectTap, and raw /ws touches ──────────

const servers: Server[] = [];
const sessions: DeviceSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) session.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.close(() => resolve());
    s.closeAllConnections();
  })));
});

/** One button whose center is at DISPLAY on a screen of the given point size. */
function axTree(screen: { width: number; height: number }): RawAxeNode[] {
  const leaf = (label: string, frame: RawAxeNode["frame"], type: string, children: RawAxeNode[] = []): RawAxeNode => ({
    AXUniqueId: null,
    AXLabel: label,
    AXValue: null,
    enabled: true,
    frame,
    role_description: type.toLowerCase(),
    type,
    children,
  });
  const cx = DISPLAY.x * screen.width;
  const cy = DISPLAY.y * screen.height;
  return [leaf("", { x: 0, y: 0, ...screen }, "Application", [
    leaf("Target", { x: cx - 10, y: cy - 10, width: 20, height: 20 }, "Button"),
  ])];
}

interface ServerHarness {
  session: DeviceSession;
  touches: Array<Touch & { w: number; h: number }>;
  orientationCalls: number[];
  /** Send one HID frame as the browser viewer would. */
  send: (tag: number, payload: unknown) => void;
  setDuoState?: (state: DuoState) => void;
}

function serverHarness(opts: { screen: { width: number; height: number }; foldable?: boolean }): ServerHarness {
  const touches: ServerHarness["touches"] = [];
  const orientationCalls: number[] = [];
  let setDuoState: ((state: DuoState) => void) | undefined;
  const deps: DeviceSessionDependencies = {
    capture: {
      start: async () => {},
      stop: async () => {},
      subscribeMjpeg: async () => () => {},
      subscribeAvcc: async () => () => {},
      subscribeSize: async (cb) => { void cb({ width: RAW_W, height: RAW_H }); return () => {}; },
      snapshotJpeg: async () => null,
      setPreferredScreenSize: async () => {},
      contentChangeCount: () => 1,
    },
    hid: {
      touch: async (type, x, y, w, h, edge) => { touches.push({ type, x, y, w, h, edge }); return true; },
      multiTouch: async () => true,
      button: async () => true,
      buttonHid: async () => true,
      key: async () => {},
      scroll: async () => {},
      digitalCrown: async () => {},
      orientation: async (value) => { orientationCalls.push(value); return true; },
      memoryWarning: async () => {},
      softwareKeyboard: async () => {},
      caDebug: async () => false,
      hardwareKeyboard: async () => false,
      pose: async () => true,
      hinge: async () => true,
      isFoldable: async () => opts.foldable === true,
    },
    axDescribe: async () => JSON.stringify(axTree(opts.screen)),
    readDeviceHubInputShadowed: async () => false,
    createDuoMonitor: (_udid, onState) => {
      setDuoState = onState;
      return { close() {}, refreshOrientation() {} };
    },
    rollingBuffer: null,
  };
  const session = new DeviceSession("TOUCH-ROTATION-SERVER", deps);
  sessions.push(session);
  let receive!: (data: Buffer) => void;
  session.attachHidSocket({
    send() {},
    close() {},
    on(event: string, cb: (data: Buffer) => void) { if (event === "message") receive = cb; },
  } as never);
  return {
    session,
    touches,
    orientationCalls,
    send: (tag, payload) => receive(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))])),
    get setDuoState() { return setDuoState; },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function serveAx(session: DeviceSession): Promise<string> {
  const server = createServer((req, res) => {
    const endpoint = AX_AGENT_ENDPOINTS[(req.url ?? "").split("?")[0]!];
    if (endpoint) void session.handleAxAgent(req, res, endpoint);
    else res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function rotate(h: ServerHarness, orientation: Orientation): Promise<void> {
  await h.session.start();
  await waitFor(() => h.session.screenConfig().width === RAW_W);
  if (orientation !== "portrait") {
    const before = h.orientationCalls.length;
    h.send(0x07, { orientation });
    await waitFor(() => h.orientationCalls.length > before && h.session.screenConfig().orientation === orientation);
  }
}

async function axTap(session: DeviceSession): Promise<Response> {
  const base = await serveAx(session);
  expect((await fetch(`${base}/ax/snapshot`)).status).toBe(200);
  return fetch(`${base}/ax/act`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "@e1" }),
  });
}

const screenFor = (o: Orientation) =>
  o === "landscape_left" || o === "landscape_right" ? { width: 874, height: 402 } : { width: 402, height: 874 };

describe("server /ax/act taps remap display coords for every orientation (#153)", () => {
  for (const orientation of ORIENTATIONS) {
    test(`${orientation}: the element center reaches HID as the raw portrait point`, async () => {
      const h = serverHarness({ screen: screenFor(orientation) });
      await rotate(h, orientation);
      const res = await axTap(h.session);
      expect(res.status).toBe(200);
      expect(h.touches.map((t) => t.type)).toEqual(["begin", "end"]);
      for (const t of h.touches) {
        expectRaw(t, orientation);
        expect([t.w, t.h, t.edge]).toEqual([RAW_W, RAW_H, 0]);
      }
    });
  }

  test("a Duo (hinge reported) taps unrotated, like the Duo viewer", async () => {
    const h = serverHarness({ screen: screenFor("landscape_left"), foldable: true });
    await h.session.start();
    await waitFor(() => h.setDuoState != null);
    h.setDuoState!({ hingeDegrees: 180, orientations: { inner: "landscape_left" } });
    await waitFor(() => h.session.screenConfig().hingeDegrees === 180 && h.session.screenConfig().orientation === "landscape_left");
    const res = await axTap(h.session);
    expect(res.status).toBe(200);
    expect(h.touches[0]!.x).toBeCloseTo(DISPLAY.x, 6);
    expect(h.touches[0]!.y).toBeCloseTo(DISPLAY.y, 6);
  });
});

describe("server /ws touches are forwarded unmodified in every orientation", () => {
  // The browser viewer already converts to raw coords before sending 0x03,
  // so the server must not rotate them again.
  for (const orientation of ORIENTATIONS) {
    test(`${orientation}: 0x03 begin/move/end reach HID exactly as sent`, async () => {
      const h = serverHarness({ screen: screenFor(orientation) });
      await rotate(h, orientation);
      h.send(0x03, { type: "begin", x: 0.11, y: 0.22, edge: 3 });
      h.send(0x03, { type: "move", x: 0.33, y: 0.44 });
      h.send(0x03, { type: "end", x: 0.55, y: 0.66 });
      await waitFor(() => h.touches.length === 3);
      expect(h.touches).toEqual([
        { type: "begin", x: 0.11, y: 0.22, w: RAW_W, h: RAW_H, edge: 3 },
        { type: "move", x: 0.33, y: 0.44, w: RAW_W, h: RAW_H, edge: 0 },
        { type: "end", x: 0.55, y: 0.66, w: RAW_W, h: RAW_H, edge: 0 },
      ]);
    });
  }
});
