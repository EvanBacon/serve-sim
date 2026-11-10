import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import { join } from "path";
import { WebSocketServer } from "ws";

// Drives the real CLI (`ax --refs`, `tap @eN`, `settle`, and the unchanged
// coordinate `tap`) against a fake preview reached through SERVE_SIM_URL, so
// the request shape, auth header, stdout JSON and exit codes are all pinned.

const TOKEN = "ax-refs-cli-token";
const DEVICE = "AX-REFS-CLI-DEVICE";
const cli = join(import.meta.dir, "..", "index.ts");

let server: Server;
let url = "";
const requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];
const wsFrames: Buffer[] = [];

const SNAPSHOT = {
  screen: { width: 402, height: 874 },
  nodes: [{ ref: "@e1", role: "cell", type: "Cell", label: "General", frame: { x: 0, y: 300, w: 402, h: 52 }, center: { x: 201, y: 326 } }],
};

const RAW_TREE = [{
  AXUniqueId: null, AXLabel: null, AXValue: null, enabled: true, role_description: "application", type: "Application",
  frame: { x: 0, y: 0, width: 402, height: 874 },
  children: [{ AXUniqueId: null, AXLabel: "General", AXValue: null, enabled: true, role_description: "cell", type: "Cell", frame: { x: 0, y: 300, width: 402, height: 52 }, children: [] }],
}];

beforeAll(async () => {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const json = (status: number, payload: unknown) =>
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" });
      const path = (req.url ?? "").split("?")[0];
      if (path === "/api") return json(200, { device: DEVICE });
      if (path === `/helper/${DEVICE}/ax/snapshot`) return json(200, SNAPSHOT);
      if (path === `/helper/${DEVICE}/ax`) return json(200, RAW_TREE);
      if (path === `/helper/${DEVICE}/ax/settle`) return json(200, { settle: { settled: true, waitedMs: 210, reason: "frames-quiet" }, diff: { added: [], removed: [], changed: [] } });
      if (path === `/helper/${DEVICE}/ax/act`) {
        const ref = (JSON.parse(body) as { ref: string }).ref;
        if (ref === "@e9") return json(409, { error: "stale_ref", message: "@e9 is stale: the element it named (cell \"Old\") is no longer on screen. Run `serve-sim ax --refs` to take a fresh snapshot, then retry with a current ref." });
        return json(200, { ok: true, action: "tap", ref, settle: null, diff: null });
      }
      json(404, { error: "not_found" });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== `/helper/${DEVICE}/ws`) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => wsFrames.push(Buffer.from(data as Buffer))));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function runCli(args: string[], opts: { viaFlags?: boolean } = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, SERVE_SIM_URL: url, SERVE_SIM_AUTH_TOKEN: TOKEN };
  if (opts.viaFlags) {
    // Only --url / --auth-token point at the remote, as for tap and settle.
    delete env.SERVE_SIM_URL;
    delete env.SERVE_SIM_AUTH_TOKEN;
    args = [...args, "--url", url, "--auth-token", TOKEN];
  }
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const lastRequest = () => requests[requests.length - 1]!;

describe("serve-sim ax --refs / tap @ref / settle", () => {
  test("ax --refs prints the snapshot JSON on stdout", async () => {
    const r = await runCli(["ax", "--refs", "-d", DEVICE]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(SNAPSHOT);
    expect(lastRequest().url).toBe(`/helper/${DEVICE}/ax/snapshot`);
    expect(lastRequest().headers.authorization).toBe(`Bearer ${TOKEN}`);
  }, 25_000);

  test("ax --refs reaches a remote server through --url / --auth-token like tap and settle", async () => {
    const r = await runCli(["ax", "--refs", "-d", DEVICE], { viaFlags: true });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(SNAPSHOT);
    expect(lastRequest().url).toBe(`/helper/${DEVICE}/ax/snapshot`);
    expect(lastRequest().headers.authorization).toBe(`Bearer ${TOKEN}`);
  }, 25_000);

  test("plain ax dumps a remote server's tree through --url / --auth-token", async () => {
    const r = await runCli(["ax", "-d", DEVICE], { viaFlags: true });
    expect(r.status).toBe(0);
    expect(lastRequest().url).toBe(`/helper/${DEVICE}/ax`);
    expect(lastRequest().headers.authorization).toBe(`Bearer ${TOKEN}`);
    const dump = JSON.parse(r.stdout) as { elements: Array<{ label: string }> };
    expect(dump.elements.map((e) => e.label)).toEqual(["General"]);
  }, 25_000);

  test("tap @e1 and settle accept --url / --auth-token too", async () => {
    expect((await runCli(["tap", "@e1", "-d", DEVICE], { viaFlags: true })).status).toBe(0);
    expect(lastRequest().url).toBe(`/helper/${DEVICE}/ax/act`);
    expect((await runCli(["settle", "-d", DEVICE], { viaFlags: true })).status).toBe(0);
    expect(lastRequest().url).toBe(`/helper/${DEVICE}/ax/settle`);
  }, 25_000);

  test("ax --refs --all --text asks for offscreen nodes and prints lines", async () => {
    const r = await runCli(["ax", "--refs", "--all", "--text", "-d", DEVICE]);
    expect(r.status).toBe(0);
    expect(lastRequest().url).toBe(`/helper/${DEVICE}/ax/snapshot?all=1`);
    expect(r.stdout.trim()).toBe('screen 402x874\n@e1 cell "General" (0,300 402x52)');
  }, 25_000);

  test("tap @e1 --settle --timeout posts the ref and prints the result JSON", async () => {
    const r = await runCli(["tap", "@e1", "--settle", "--timeout", "1500", "-d", DEVICE]);
    expect(r.status).toBe(0);
    expect(lastRequest()).toMatchObject({ method: "POST", url: `/helper/${DEVICE}/ax/act` });
    expect(lastRequest().headers["content-type"]).toBe("application/json");
    expect(JSON.parse(lastRequest().body)).toEqual({ ref: "@e1", settle: true, timeoutMs: 1500 });
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, ref: "@e1" });
  }, 25_000);

  test("a stale ref exits non-zero with the server's message on stderr and nothing on stdout", async () => {
    const r = await runCli(["tap", "@e9", "-d", DEVICE]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("stale_ref: @e9 is stale");
    expect(r.stderr).toContain("serve-sim ax --refs");
  }, 25_000);

  test("settle --timeout passes the timeout and prints the JSON", async () => {
    const r = await runCli(["settle", "--timeout", "500", "-d", DEVICE]);
    expect(r.status).toBe(0);
    expect(lastRequest().url).toBe(`/helper/${DEVICE}/ax/settle?timeoutMs=500`);
    expect(JSON.parse(r.stdout)).toMatchObject({ settle: { settled: true } });
  }, 25_000);

  test("coordinate taps still go over the HID socket as before", async () => {
    wsFrames.length = 0;
    const before = requests.length;
    const r = await runCli(["tap", "0.25", "0.75", "-d", DEVICE]);
    expect(r.status).toBe(0);
    const touches = wsFrames.filter((f) => f[0] === 0x03).map((f) => JSON.parse(f.subarray(1).toString()));
    expect(touches).toEqual([{ type: "begin", x: 0.25, y: 0.75 }, { type: "end", x: 0.25, y: 0.75 }]);
    // No /ax/* call for a coordinate tap.
    expect(requests.slice(before).some((q) => q.url.includes("/ax/"))).toBe(false);
  }, 25_000);

  test("a lone coordinate is a usage error, not a tap at y=0", async () => {
    wsFrames.length = 0;
    const r = await runCli(["tap", "0.5", "-d", DEVICE]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: serve-sim tap <x> <y>");
    expect(wsFrames).toEqual([]);
  }, 25_000);
});
