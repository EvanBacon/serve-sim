import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { join } from "path";
import { WebSocketServer } from "ws";

// #136: tap/button/gesture used to fire their frame, wait 50ms and exit 0 no
// matter what the server did with it. They now ask for an ack and exit 1 when
// the server reports the injector could not deliver. A server that never acks
// (an older serve-sim) keeps the old exit-0 behaviour.

const ACK_TAG = 0x84;
const cli = join(import.meta.dir, "..", "index.ts");

type Mode = "ok" | "fail" | "silent";
const devices: Record<string, Mode> = { "ACK-OK": "ok", "ACK-FAIL": "fail", "ACK-SILENT": "silent" };

let PORT = 0;
let server: Server;
const frames: Buffer[] = [];

beforeAll(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/api") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ device: url.searchParams.get("device") }));
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
      if (mode === "silent") return;
      const body = JSON.parse(frame.subarray(1).toString()) as { ack?: number };
      if (typeof body.ack !== "number") return;
      ws.send(Buffer.concat([Buffer.from([ACK_TAG]), Buffer.from(JSON.stringify({ ack: body.ack, ok: mode === "ok" }))]));
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

function runCli(args: string[]): Promise<{ status: number | null; stderr: string }> {
  const env = { ...process.env };
  delete env.SERVE_SIM_URL;
  delete env.SERVE_SIM_AUTH_TOKEN;
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, ...args, "--url", `http://127.0.0.1:${PORT}`], { env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
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

    test(`${name} still exits 0 against a server that never acks`, async () => {
      const r = await runCli([...args, "-d", "ACK-SILENT"]);
      expect(r.status).toBe(0);
    }, 25_000);
  }

  test("tap tags begin and end with distinct ack ids", async () => {
    frames.length = 0;
    await runCli(["tap", "0.1", "0.2", "-d", "ACK-OK"]);
    const bodies = frames.map((f) => JSON.parse(f.subarray(1).toString()) as { type: string; ack: number });
    expect(bodies.map((b) => b.type)).toEqual(["begin", "end"]);
    expect(new Set(bodies.map((b) => b.ack)).size).toBe(2);
  }, 25_000);
});
