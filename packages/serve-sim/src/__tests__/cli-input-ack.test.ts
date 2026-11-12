import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { join } from "path";
import { WebSocketServer } from "ws";
import { previewConfigForState } from "../middleware";
import { inProcessServeSimState } from "../state";

// #136: tap/button/gesture used to fire their frame, wait 50ms and exit 0 no
// matter what the server did with it. They now ask for an ack and exit 1 when
// the server reports the injector could not deliver. Servers advertise acks
// with `inputAck` in /api; one that doesn't (an older serve-sim) gets untagged
// frames and the old fast fire-and-forget exit 0.

const ACK_TAG = 0x84;
const cli = join(import.meta.dir, "..", "index.ts");

// ok/fail: advertises acks and replies. close: advertises, then drops the
// socket without replying. hung: advertises but never replies. legacy: an
// older server that neither advertises nor replies.
type Mode = "ok" | "fail" | "close" | "hung" | "legacy" | "shadow" | "inputAckOnly";
const devices: Record<string, Mode> = {
  "ACK-OK": "ok",
  "ACK-FAIL": "fail",
  "ACK-CLOSE": "close",
  "ACK-HUNG": "hung",
  "ACK-LEGACY": "legacy",
  "ACK-SHADOW": "shadow",
  "ACK-KEY-OLD": "inputAckOnly",
};

let PORT = 0;
let server: Server;
const frames: Buffer[] = [];

beforeAll(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api") {
      const device = url.searchParams.get("device");
      const advertises = device !== null && devices[device] !== undefined && devices[device] !== "legacy";
      const keyAck = advertises && devices[device] !== "inputAckOnly";
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ device, ...(advertises ? { inputAck: true } : {}), ...(keyAck ? { keyAck: true } : {}) }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    const device = /^\/helper\/([^/]+)\/ws$/.exec(req.url ?? "")?.[1];
    const mode = device ? devices[device] : undefined;
    if (!mode) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => {
      const frame = Buffer.from(data as Buffer);
      frames.push(frame);
      if (mode === "close") { ws.terminate(); return; }
      if (mode === "hung" || mode === "legacy") return;
      const body = JSON.parse(frame.subarray(1).toString()) as { ack?: number };
      // Pre-keyAck servers advertised inputAck but never replied to key frames.
      if (mode === "inputAckOnly" && frame[0] === 0x06) return;
      if (typeof body.ack !== "number") return;
      const reply = mode === "shadow"
        ? { ack: body.ack, ok: false, error: "Device Hub has disconnected legacy input. Run serve-sim repair-input -d ACK-SHADOW before using touch or keyboard." }
        : { ack: body.ack, ok: mode === "ok" };
      ws.send(Buffer.concat([Buffer.from([ACK_TAG]), Buffer.from(JSON.stringify(reply))]));
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  PORT = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function runCli(args: string[]): Promise<{ status: number | null; stderr: string; ms: number }> {
  const env = { ...process.env };
  delete env.SERVE_SIM_URL;
  delete env.SERVE_SIM_AUTH_TOKEN;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bun", ["run", cli, ...args, "--url", `http://127.0.0.1:${PORT}`], { env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr, ms: Date.now() - started });
    });
  });
}

describe("input commands propagate HID delivery failures (#136)", () => {
  for (const [name, args] of [
    ["tap", ["tap", "0.5", "0.5"]],
    ["button", ["button", "lock"]],
    ["gesture", ["gesture", '{"type":"begin","x":0.5,"y":0.5}']],
  ] as const) {
    test(`${name} exits 0 when the server acks delivery`, async () => {
      const r = await runCli([...args, "-d", "ACK-OK"]);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
    }, 25_000);

    test(`${name} exits 1 with a clear error when the injector could not deliver`, async () => {
      const r = await runCli([...args, "-d", "ACK-FAIL"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("could not deliver");
      expect(r.stderr).toContain("ACK-FAIL");
    }, 25_000);

    test(`${name} exits 1 when the server closes the socket before acking`, async () => {
      const r = await runCli([...args, "-d", "ACK-CLOSE"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("closed the connection");
    }, 25_000);

    test(`${name} does not wait for acks from an older server`, async () => {
      frames.length = 0;
      const r = await runCli([...args, "-d", "ACK-LEGACY"]);
      expect(r.status).toBe(0);
      // The CLI process itself takes a while to start; the point is that it
      // never sits out the 4s ack timeout.
      expect(r.ms).toBeLessThan(3_500);
      expect(frames.length).toBeGreaterThan(0);
      for (const f of frames) expect(JSON.parse(f.subarray(1).toString())).not.toHaveProperty("ack");
    }, 25_000);
  }

  test("tap prints the server's Device Hub error and exits 1", async () => {
    const r = await runCli(["tap", "0.5", "0.5", "-d", "ACK-SHADOW"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("serve-sim: Device Hub has disconnected legacy input");
    expect(r.stderr).toContain("repair-input -d ACK-SHADOW");
    expect(r.stderr).not.toContain("could not deliver");
  }, 25_000);

  test("an advertising server that never acks exits 0 with a warning after the timeout", async () => {
    const r = await runCli(["button", "lock", "-d", "ACK-HUNG"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("serve-sim: no delivery confirmation within 4s; input may not have reached ACK-HUNG");
    expect(r.stderr.trim().split("\n")).toHaveLength(1);
  }, 25_000);

  test("tap tags begin and end with distinct ack ids", async () => {
    frames.length = 0;
    await runCli(["tap", "0.1", "0.2", "-d", "ACK-OK"]);
    const bodies = frames.map((f) => JSON.parse(f.subarray(1).toString()) as { type: string; ack: number });
    expect(bodies.map((b) => b.type)).toEqual(["begin", "end"]);
    expect(new Set(bodies.map((b) => b.ack)).size).toBe(2);
  }, 25_000);

  test("type prints the server's Device Hub error and exits 1", async () => {
    const r = await runCli(["type", "hi", "-d", "ACK-SHADOW"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("serve-sim: Device Hub has disconnected legacy input");
    expect(r.stderr).toContain("repair-input -d ACK-SHADOW");
  }, 25_000);

  test("type does not wait for acks from a server that only advertised inputAck", async () => {
    frames.length = 0;
    const r = await runCli(["type", "hi", "-d", "ACK-KEY-OLD"]);
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(3_500);
    expect(r.stderr).not.toContain("no delivery confirmation");
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(JSON.parse(f.subarray(1).toString())).not.toHaveProperty("ack");
  }, 25_000);
});

test("servers advertise input acks in their state file and /api (#136)", () => {
  const state = inProcessServeSimState("ADVERTISE", 3999);
  expect(state.inputAck).toBe(true);
  expect(state.keyAck).toBe(true);
  const preview = previewConfigForState(state, "", "serve-sim", false);
  expect(preview.inputAck).toBe(true);
  expect(preview.keyAck).toBe(true);
});
