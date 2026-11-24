import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from "http";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import type { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { simMiddleware } from "../middleware";
import { createOpenUrlRoute, handleScreenshotRequest, validateOpenUrl, type HostRunner } from "../remote-actions";

// `POST /openurl` and `GET /helper/<udid>/screenshot`: fixed host actions that
// let a remote (e.g. Linux) client open links and grab frames.

delete process.env.SERVE_SIM_AUTH_TOKEN;
(globalThis as Record<string, unknown>).__PREVIEW_HTML_B64__ = Buffer.from("<!doctype html><html></html>").toString("base64");

const UDID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "remote-actions-token";
const PROXY = { "X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "https" };

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

function send(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as AddressInfo).port })));
}

describe("validateOpenUrl", () => {
  test("accepts web and app-scheme URLs", () => {
    for (const url of ["https://example.com", "http://localhost:8081/x?y=1", "exp://192.168.1.2:8081", "myapp://path/to?id=1", "mailto:a@b.c"]) {
      expect(validateOpenUrl(url)).toEqual({ ok: true, url });
    }
  });
  test("rejects non-strings, missing schemes, whitespace, file/script schemes, and huge URLs", () => {
    for (const bad of [42, "", "example.com", "/etc/passwd", "https://a b", "https://a\nb", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "https://", "-x://y", `https://a.example/${"x".repeat(9000)}`]) {
      expect(validateOpenUrl(bad).ok).toBe(false);
    }
  });
});

describe("POST /openurl route", () => {
  const calls: { file: string; args: readonly string[] }[] = [];
  let failWith: string | undefined;
  const run: HostRunner = async (file, args) => {
    calls.push({ file, args });
    if (failWith) throw new Error(failWith);
    return { stdout: Buffer.alloc(0) };
  };
  const route = createOpenUrlRoute({ simctlArgs: (a) => ["simctl", ...a], servesDevice: async (u) => u === UDID, run });
  let srv: { server: Server; port: number };
  beforeAll(async () => {
    srv = await listen((req, res) => route(req, res, new URL(req.url!, "http://x").searchParams.get("device")));
  });
  afterAll(() => srv.server.close());
  const json = { "Content-Type": "application/json" };

  test("runs simctl openurl with a fixed argv", async () => {
    calls.length = 0;
    const r = await send(srv.port, `/openurl?device=${UDID}`, { method: "POST", headers: json, body: JSON.stringify({ url: "https://example.com/a?b=1" }) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString())).toEqual({ ok: true });
    expect(calls).toEqual([{ file: "xcrun", args: ["simctl", "openurl", UDID, "https://example.com/a?b=1"] }]);
  });

  test("rejects a bad URL, a bad device, non-JSON, and unknown devices without running anything", async () => {
    calls.length = 0;
    expect((await send(srv.port, `/openurl?device=${UDID}`, { method: "POST", headers: json, body: JSON.stringify({ url: "file:///etc/passwd" }) })).status).toBe(400);
    expect((await send(srv.port, `/openurl?device=${UDID}`, { method: "POST", headers: json, body: "{" })).status).toBe(400);
    expect((await send(srv.port, `/openurl?device=nope;rm`, { method: "POST", headers: json, body: JSON.stringify({ url: "https://a.example" }) })).status).toBe(400);
    expect((await send(srv.port, `/openurl?device=${UDID}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "https://a.example" })).status).toBe(415);
    expect((await send(srv.port, `/openurl?device=AAAAAAAA-2222-3333-4444-555555555555`, { method: "POST", headers: json, body: JSON.stringify({ url: "https://a.example" }) })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("a simctl failure is a 502 with the detail", async () => {
    failWith = "Simulator device failed to open https://a.example";
    try {
      const r = await send(srv.port, `/openurl?device=${UDID}`, { method: "POST", headers: json, body: JSON.stringify({ url: "https://a.example" }) });
      expect(r.status).toBe(502);
      expect(JSON.parse(r.body.toString()).detail).toContain("failed to open");
    } finally {
      failWith = undefined;
    }
  });
});

describe("GET /helper/<udid>/screenshot handler", () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  let jpeg: Uint8Array | null = JPEG;
  const shotDir = mkdtempSync(join(tmpdir(), "serve-sim-shot-"));
  const pngCalls: (readonly string[])[] = [];
  let srv: { server: Server; port: number };
  beforeAll(async () => {
    srv = await listen((req, res) =>
      void handleScreenshotRequest(req, res, UDID, {
        snapshotJpeg: async () => jpeg,
        simctlArgs: (a) => ["simctl", ...a],
        run: async (_f, args) => {
          pngCalls.push(args);
          writeFileSync(String(args.at(-1)), PNG);
          return { stdout: Buffer.alloc(0) };
        },
        tmpDir: shotDir,
      }),
    );
  });
  afterAll(() => {
    srv.server.close();
    rmSync(shotDir, { recursive: true, force: true });
  });

  test("default is a JPEG from the capture pipeline", async () => {
    const r = await send(srv.port, "/screenshot");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("image/jpeg");
    expect(r.body.equals(JPEG)).toBe(true);
    expect(pngCalls).toHaveLength(0);
  });

  test("?format=png writes simctl's PNG to a private temp file, sends it, and removes it", async () => {
    const r = await send(srv.port, "/screenshot?format=png");
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.body.equals(PNG)).toBe(true);
    expect(pngCalls).toHaveLength(1);
    const args = pngCalls[0]!;
    expect(args.slice(0, 5)).toEqual(["simctl", "io", UDID, "screenshot", "--type=png"]);
    // simctl writes `-` to a file literally named "-", so never pass it.
    expect(args.at(-1)).not.toBe("-");
    expect(String(args.at(-1)).startsWith(join(shotDir, "serve-sim-screenshot-"))).toBe(true);
    expect(readdirSync(shotDir)).toEqual([]);
  });

  test("no frame yet is 503, bad format 400, POST 405", async () => {
    jpeg = null;
    expect((await send(srv.port, "/screenshot")).status).toBe(503);
    jpeg = JPEG;
    expect((await send(srv.port, "/screenshot?format=gif")).status).toBe(400);
    expect((await send(srv.port, "/screenshot", { method: "POST" })).status).toBe(405);
  });
});

describe("auth gate on a token-configured server", () => {
  let srv: { server: Server; port: number };
  const runs: (readonly string[])[] = [];
  beforeAll(async () => {
    const mw = simMiddleware({
      basePath: "/",
      device: UDID,
      authToken: TOKEN,
      servesDevice: async () => true,
      openUrlRunner: async (_f, args) => { runs.push(args); return { stdout: Buffer.alloc(0) }; },
    });
    srv = await listen((req, res) => void mw(req, res, async () => { res.statusCode = 404; res.end(); }));
  });
  afterAll(() => {
    srv.server.closeAllConnections();
    srv.server.close();
  });
  const json = { "Content-Type": "application/json" };
  const body = JSON.stringify({ url: "https://example.com" });

  test("remote requests without the token are 401 (screenshot, openurl, api)", async () => {
    expect((await send(srv.port, `/helper/${UDID}/screenshot`, { headers: PROXY })).status).toBe(401);
    expect((await send(srv.port, `/api`, { headers: PROXY })).status).toBe(401);
    expect((await send(srv.port, `/openurl?device=${UDID}`, { method: "POST", headers: { ...json, ...PROXY }, body })).status).toBe(401);
    expect((await send(srv.port, `/openurl?device=${UDID}`, { method: "POST", headers: { ...json, ...PROXY, Authorization: "Bearer wrong" }, body })).status).toBe(401);
    expect(runs).toHaveLength(0);
  });

  test("a remote bearer reaches /openurl; a cross-site browser POST does not", async () => {
    const ok = await send(srv.port, `/openurl?device=${UDID}`, { method: "POST", headers: { ...json, ...PROXY, Authorization: `Bearer ${TOKEN}` }, body });
    expect(ok.status).toBe(200);
    expect(runs.at(-1)).toEqual(["simctl", "openurl", UDID, "https://example.com"]);
    const cross = await send(srv.port, `/openurl?device=${UDID}`, { method: "POST", headers: { ...json, Origin: "http://evil.example" }, body });
    expect(cross.status).toBe(403);
  });
});
