import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import { join } from "path";
import { WebSocketServer } from "ws";

// `serve-sim tap` / `gesture` read the device's /config to decide whether to
// remap display coords into the raw portrait frame (#153). Against an
// authenticated remote preview (#166) that lookup has to carry the same
// bearer token as /api and the HID socket, or landscape taps silently miss.

const PORT = 3565;
const TOKEN = "remote-touch-remap-token";
const DEVICE = "REMOTE-TOUCH-DEVICE";
const cli = join(import.meta.dir, "..", "index.ts");

// iPad raw frame stays portrait after the UI rotates.
const LANDSCAPE_LEFT = { width: 2064, height: 2752, orientation: "landscape_left" };

let server: Server;
let configStatus = 200;
let configBody: object = LANDSCAPE_LEFT;
const configHeaders: IncomingHttpHeaders[] = [];
const touches: { type: string; x: number; y: number; edge?: number }[] = [];

beforeAll(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
    if (req.url?.startsWith("/api")) {
      if (!authorized) return void res.writeHead(401).end();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ device: DEVICE }));
      return;
    }
    if (req.url === `/helper/${DEVICE}/config`) {
      configHeaders.push(req.headers);
      if (!authorized) return void res.writeHead(401).end();
      if (configStatus !== 200) return void res.writeHead(configStatus).end();
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(configBody));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== `/helper/${DEVICE}/ws` || req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      ws.on("message", (data) => {
        const buf = Buffer.from(data as Buffer);
        if (buf[0] === 0x03) touches.push(JSON.parse(buf.subarray(1).toString("utf8")));
      }),
    );
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});

afterAll(() => server?.close());

beforeEach(() => {
  configStatus = 200;
  configBody = LANDSCAPE_LEFT;
  configHeaders.length = 0;
  touches.length = 0;
});

function runCli(args: string[]): Promise<{ status: number | null; stderr: string }> {
  const env = { ...process.env };
  delete env.SERVE_SIM_URL;
  delete env.SERVE_SIM_AUTH_TOKEN;
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, ...args], { env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

const remote = ["--url", `http://127.0.0.1:${PORT}`, "--auth-token", TOKEN, "-d", DEVICE];

describe("CLI touch remap against an authenticated remote preview", () => {
  test("tap sends the auth token on /config and remaps landscape coords", async () => {
    const r = await runCli(["tap", "0.715", "0.343", ...remote]);
    expect(r.status).toBe(0);
    expect(configHeaders.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(touches.map((t) => t.type)).toEqual(["begin", "end"]);
    // landscape_left: display (x, y) → raw (y, 1 - x)
    expect(touches[0]!.x).toBeCloseTo(0.343, 6);
    expect(touches[0]!.y).toBeCloseTo(0.285, 6);
    expect(r.stderr).not.toContain("remap skipped");
  }, 25_000);

  test("gesture sends the auth token on /config and remaps landscape coords", async () => {
    const r = await runCli(["gesture", '{"type":"begin","x":0.2,"y":0.9}', ...remote]);
    expect(r.status).toBe(0);
    expect(configHeaders.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(touches).toHaveLength(1);
    expect(touches[0]!.x).toBeCloseTo(0.9, 6);
    expect(touches[0]!.y).toBeCloseTo(0.8, 6);
  }, 25_000);

  for (const status of [401, 403]) {
    test(`/config HTTP ${status} warns on stderr and sends coords unmapped`, async () => {
      configStatus = status;
      const r = await runCli(["tap", "0.715", "0.343", ...remote]);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`HTTP ${status}`);
      expect(r.stderr).toContain("remap skipped");
      expect(r.stderr).toContain("--auth-token");
      expect(r.stderr).toContain("--raw");
      expect(touches[0]).toMatchObject({ type: "begin", x: 0.715, y: 0.343 });
    }, 25_000);
  }

  test("foldables (hingeDegrees set) skip the remap", async () => {
    configBody = { ...LANDSCAPE_LEFT, hingeDegrees: 180 };
    const r = await runCli(["tap", "0.715", "0.343", ...remote]);
    expect(r.status).toBe(0);
    expect(touches[0]).toMatchObject({ type: "begin", x: 0.715, y: 0.343 });
    expect(r.stderr).not.toContain("remap skipped");
  }, 25_000);

  test("--raw skips the /config lookup entirely", async () => {
    const r = await runCli(["tap", "0.715", "0.343", "--raw", ...remote]);
    expect(r.status).toBe(0);
    expect(configHeaders).toHaveLength(0);
    expect(touches[0]).toMatchObject({ type: "begin", x: 0.715, y: 0.343 });
  }, 25_000);
});
