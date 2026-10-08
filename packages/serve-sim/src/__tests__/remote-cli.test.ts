import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import { join } from "path";
import { WebSocketServer } from "ws";

// `--url` / `SERVE_SIM_URL` point the input commands at a remote preview; the
// auth token must ride along on both the /api lookup and the HID WebSocket.

const PORT = 3564;
const TOKEN = "remote-cli-test-token";
const DEVICE = "REMOTE-CLI-DEVICE";
const cli = join(import.meta.dir, "..", "index.ts");

let server: Server;
const apiHeaders: IncomingHttpHeaders[] = [];
const wsHeaders: IncomingHttpHeaders[] = [];
const wsFrames: Buffer[] = [];

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
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});

afterAll(() => server?.close());

// Async spawn: the fake server lives in this process, so a sync spawn would
// block the event loop it needs to answer the CLI.
function runCli(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stderr: string }> {
  const cleanEnv = { ...process.env };
  delete cleanEnv.SERVE_SIM_URL;
  delete cleanEnv.SERVE_SIM_AUTH_TOKEN;
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, ...args], { env: { ...cleanEnv, ...env } });
    let stderr = "";
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
