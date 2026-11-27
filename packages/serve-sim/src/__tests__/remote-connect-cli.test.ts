import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { WebSocketServer } from "ws";

// `serve-sim connect` / `disconnect` and the remote-capable `screenshot` /
// `open` commands, against fake preview servers. No simulator needed.

const TOKEN = "connect-cli-test-token";
const cli = join(import.meta.dir, "..", "index.ts");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0x30]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Fake {
  name: string;
  server: Server;
  port: number;
  url: string;
  api: IncomingHttpHeaders[];
  ws: IncomingHttpHeaders[];
  shots: { url: string; headers: IncomingHttpHeaders }[];
  opens: { url: string; headers: IncomingHttpHeaders; body: string }[];
}

async function fakeServer(name: string): Promise<Fake> {
  const device = `DEVICE-${name}`;
  const fake = { name, api: [], ws: [], shots: [], opens: [] } as unknown as Fake;
  const wss = new WebSocketServer({ noServer: true });
  const authed = (h: IncomingHttpHeaders) => h.authorization === `Bearer ${TOKEN}`;
  fake.server = createServer((req, res) => {
    if (!authed(req.headers)) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.url?.startsWith("/api")) {
      fake.api.push(req.headers);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ device }));
      return;
    }
    if (req.url?.startsWith(`/helper/${device}/screenshot`)) {
      fake.shots.push({ url: req.url, headers: req.headers });
      const png = req.url.includes("format=png");
      res.writeHead(200, { "Content-Type": png ? "image/png" : "image/jpeg" }).end(png ? PNG : JPEG);
      return;
    }
    if (req.url?.startsWith("/openurl") && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        fake.opens.push({ url: req.url!, headers: req.headers, body });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  fake.server.on("upgrade", (req, socket, head) => {
    if (req.url !== `/helper/${device}/ws`) return socket.destroy();
    fake.ws.push(req.headers);
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", () => {}));
  });
  await new Promise<void>((r) => fake.server.listen(0, "127.0.0.1", r));
  fake.port = (fake.server.address() as AddressInfo).port;
  fake.url = `http://127.0.0.1:${fake.port}`;
  return fake;
}

let a: Fake;
let b: Fake;
let home: string;
let xdg: string;
let cwd: string;

beforeAll(async () => {
  a = await fakeServer("A");
  b = await fakeServer("B");
  home = mkdtempSync(join(tmpdir(), "serve-sim-connect-home-"));
  xdg = join(home, "xdg");
  cwd = mkdtempSync(join(tmpdir(), "serve-sim-connect-cwd-"));
});

afterAll(async () => {
  for (const f of [a, b]) {
    if (!f) continue;
    f.server.closeAllConnections();
    await new Promise<void>((r) => f.server.close(() => r()));
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const profilePath = () => join(xdg, "serve-sim", "remote.json");

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: Buffer; stderr: string }> {
  const clean = { ...process.env };
  delete clean.SERVE_SIM_URL;
  delete clean.SERVE_SIM_AUTH_TOKEN;
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, ...args], {
      cwd,
      env: { ...clean, HOME: home, XDG_CONFIG_HOME: xdg, ...env },
    });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdin.end();
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out), stderr });
    });
  });
}

describe("serve-sim connect / disconnect", () => {
  test("a wrong token is refused and nothing is saved", async () => {
    const r = await runCli(["connect", a.url], { SERVE_SIM_AUTH_TOKEN: "wrong" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HTTP 401");
    expect(existsSync(profilePath())).toBe(false);
  }, 25_000);

  test("an unreachable server is a clear error", async () => {
    const r = await runCli(["connect", "http://127.0.0.1:9"], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Failed to reach serve-sim");
    expect(existsSync(profilePath())).toBe(false);
  }, 25_000);

  test("a ?token= URL is refused", async () => {
    const r = await runCli(["connect", `${a.url}/?token=${TOKEN}`], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(r.status).toBe(1);
    expect(existsSync(profilePath())).toBe(false);
  }, 25_000);

  test("connect checks /api with the bearer and saves only the URL (0600)", async () => {
    const r = await runCli(["connect", `${a.url}/`], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain(`Connected to ${a.url}`);
    expect(a.api.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    const text = readFileSync(profilePath(), "utf8");
    expect(JSON.parse(text).url).toBe(a.url);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["savedAt", "url"]);
    expect(statSync(profilePath()).mode & 0o777).toBe(0o600);
    // The token is nowhere under the config dir or HOME.
    for (const f of readdirSync(home, { recursive: true }) as string[]) {
      const p = join(home, f);
      if (statSync(p).isFile()) expect(readFileSync(p, "utf8")).not.toContain(TOKEN);
    }
    const status = await runCli(["connect"]);
    expect(status.stdout.toString()).toContain(`Connected to ${a.url}`);
  }, 25_000);

  test("after connect, input commands route to the profile without --url", async () => {
    const before = a.ws.length;
    const r = await runCli(["tap", "0.5", "0.5"], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(r.stderr).not.toContain("No serve-sim server running");
    expect(a.ws.length).toBe(before + 1);
    expect(a.ws.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
  }, 25_000);

  test("SERVE_SIM_URL and --url override the saved profile", async () => {
    const aBefore = a.ws.length;
    const bBefore = b.ws.length;
    await runCli(["button", "home"], { SERVE_SIM_AUTH_TOKEN: TOKEN, SERVE_SIM_URL: b.url });
    expect(b.ws.length).toBe(bBefore + 1);
    await runCli(["tap", "0.1", "0.1", "--url", b.url], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(b.ws.length).toBe(bBefore + 2);
    expect(a.ws.length).toBe(aBefore);
  }, 25_000);

  test("screenshot writes the frame on this machine with the bearer token", async () => {
    a.shots.length = 0;
    const jpg = await runCli(["screenshot", "shot.jpg"], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(jpg.status).toBe(0);
    expect(readFileSync(join(cwd, "shot.jpg")).equals(JPEG)).toBe(true);
    const png = await runCli(["screenshot", "-o", "shot.png"], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(png.status).toBe(0);
    expect(readFileSync(join(cwd, "shot.png")).equals(PNG)).toBe(true);
    expect(a.shots.map((s) => s.url)).toEqual(["/helper/DEVICE-A/screenshot", "/helper/DEVICE-A/screenshot?format=png"]);
    expect(a.shots.every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    // Piped stdout gets the raw bytes.
    const piped = await runCli(["screenshot", "-"], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(piped.stdout.equals(JPEG)).toBe(true);
  }, 30_000);

  test("open POSTs the URL with the bearer; a bad URL never leaves the client", async () => {
    a.opens.length = 0;
    const ok = await runCli(["open", "https://example.com/x?y=1"], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(ok.status).toBe(0);
    expect(a.opens).toHaveLength(1);
    expect(a.opens[0]!.url).toBe("/openurl?device=DEVICE-A");
    expect(a.opens[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(a.opens[0]!.body)).toEqual({ url: "https://example.com/x?y=1" });
    const bad = await runCli(["open", "file:///etc/passwd"], { SERVE_SIM_AUTH_TOKEN: TOKEN });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("Invalid URL");
    expect(a.opens).toHaveLength(1);
  }, 25_000);

  test("a missing token against the profile reports the refusal", async () => {
    const r = await runCli(["open", "https://example.com"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HTTP 401");
  }, 25_000);

  test("disconnect removes the profile and commands go back to the local state", async () => {
    const r = await runCli(["disconnect"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toContain(`Disconnected from ${a.url}`);
    expect(existsSync(profilePath())).toBe(false);
    const again = await runCli(["disconnect"]);
    expect(again.stdout.toString()).toContain("Not connected");
  }, 25_000);
});
