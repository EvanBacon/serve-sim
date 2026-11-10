import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import { join } from "path";
import { WebSocketServer } from "ws";

// `--url` / `SERVE_SIM_URL` point the input commands at a remote preview; the
// auth token must ride along on both the /api lookup and the HID WebSocket.

// Ephemeral, assigned in beforeAll: a fixed port collides with other suites.
let PORT = 0;
const TOKEN = "remote-cli-test-token";
const DEVICE = "REMOTE-CLI-DEVICE";
const cli = join(import.meta.dir, "..", "index.ts");

let server: Server;
const apiHeaders: IncomingHttpHeaders[] = [];
const wsHeaders: IncomingHttpHeaders[] = [];
const wsFrames: Buffer[] = [];
const pasteRequests: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
let pasteReply: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true, verified: true, bytes: 0 } };

beforeAll(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((req, res) => {
    if (req.url?.startsWith("/api")) {
      apiHeaders.push(req.headers);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ device: DEVICE }));
      return;
    }
    if (req.url?.startsWith("/pasteboard") && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        pasteRequests.push({ url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(pasteReply.status, { "Content-Type": "application/json" }).end(JSON.stringify(pasteReply.body));
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== `/helper/${DEVICE}/ws`) {
      socket.destroy();
      return;
    }
    wsHeaders.push(req.headers);
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => wsFrames.push(Buffer.from(data as Buffer))));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  PORT = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

// Async spawn: the fake server lives in this process, so a sync spawn would
// block the event loop it needs to answer the CLI.
function runCli(
  args: string[],
  env: Record<string, string> = {},
  stdin?: string,
): Promise<{ status: number | null; stderr: string }> {
  const cleanEnv = { ...process.env };
  delete cleanEnv.SERVE_SIM_URL;
  delete cleanEnv.SERVE_SIM_AUTH_TOKEN;
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, ...args], { env: { ...cleanEnv, ...env } });
    let stderr = "";
    child.stdin.end(stdin);
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stderr });
    });
  });
}

describe("remote input commands", () => {
  test("--url without a token reports the refusal and exits non-zero", async () => {
    const r = await runCli(["tap", "0.5", "0.5", "--url", `http://127.0.0.1:${PORT}`, "-d", DEVICE]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HTTP 401");
  }, 25_000);

  test("--auth-token after the subcommand is sent on /api and the HID socket", async () => {
    wsFrames.length = 0;
    const r = await runCli(["tap", "0.25", "0.75", "--url", `http://127.0.0.1:${PORT}`, "--auth-token", TOKEN, "-d", DEVICE]);
    expect(apiHeaders.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(wsHeaders.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(wsFrames.some((f) => f[0] === 0x03)).toBe(true);
    expect(r.stderr).not.toContain("refused");
  }, 25_000);

  test("SERVE_SIM_URL + SERVE_SIM_AUTH_TOKEN work the same way", async () => {
    const before = wsHeaders.length;
    await runCli(["button", "home", "-d", DEVICE], {
      SERVE_SIM_URL: `http://127.0.0.1:${PORT}`,
      SERVE_SIM_AUTH_TOKEN: TOKEN,
    });
    expect(wsHeaders.length).toBe(before + 1);
    expect(wsHeaders.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
  }, 25_000);
});

describe("serve-sim paste (#174)", () => {
  const PAYLOAD = "Bridge123 \u0451\u0436 \u0435\u0308\u0436 \u{1F469}\u200D\u{1F373} $(id) `x`";

  test("POSTs the exact text as JSON with the bearer token, then sends Cmd+V", async () => {
    pasteRequests.length = 0;
    wsFrames.length = 0;
    pasteReply = { status: 200, body: { ok: true, verified: true, bytes: Buffer.byteLength(PAYLOAD) } };
    const r = await runCli(["paste", "--stdin", "--url", `http://127.0.0.1:${PORT}`, "--auth-token", TOKEN, "-d", DEVICE], {}, PAYLOAD);
    expect(r.status).toBe(0);
    expect(pasteRequests).toHaveLength(1);
    expect(pasteRequests[0]!.url).toBe(`/pasteboard?device=${DEVICE}`);
    expect(pasteRequests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(pasteRequests[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(pasteRequests[0]!.body)).toEqual({ text: PAYLOAD });
    const keys = wsFrames.filter((f) => f[0] === 0x06).map((f) => JSON.parse(f.subarray(1).toString()));
    expect(keys).toEqual([
      { type: "down", usage: 0xe3 },
      { type: "down", usage: 0x19 },
      { type: "up", usage: 0x19 },
      { type: "up", usage: 0xe3 },
    ]);
  }, 25_000);

  test("--no-insert stages only", async () => {
    pasteRequests.length = 0;
    wsFrames.length = 0;
    pasteReply = { status: 200, body: { ok: true, verified: true, bytes: 2 } };
    const r = await runCli(["paste", "hi", "--no-insert", "--url", `http://127.0.0.1:${PORT}`, "--auth-token", TOKEN, "-d", DEVICE]);
    expect(r.status).toBe(0);
    expect(pasteRequests).toHaveLength(1);
    expect(wsFrames).toHaveLength(0);
  }, 25_000);

  test("a server-side readback mismatch fails the command and sends no Cmd+V", async () => {
    wsFrames.length = 0;
    pasteReply = { status: 502, body: { ok: false, error: "readback_mismatch" } };
    const r = await runCli(["paste", "hi", "--url", `http://127.0.0.1:${PORT}`, "--auth-token", TOKEN, "-d", DEVICE]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("readback_mismatch");
    expect(wsFrames).toHaveLength(0);
  }, 25_000);
});
