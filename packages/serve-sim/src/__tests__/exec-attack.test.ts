import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { existsSync, readFileSync, rmSync, symlinkSync } from "fs";
import { createServer, type Server } from "http";
import { connect, type AddressInfo, type Socket } from "net";
import { tmpdir } from "os";
import { join } from "path";
import WebSocket from "ws";
import { authTokenFingerprint } from "../helper-lifecycle";
import { previewConfigForState, rewriteStateForRequestHost, simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";
import { inProcessServeSimState } from "../state";

// Real attack paths against the host shell, over real sockets.
//
// (a) A reverse proxy (nginx) on the host forwards a remote client to
//     127.0.0.1 with spoofed loopback Host/Origin plus X-Forwarded-For.
// (b) A raw TCP forward (`ssh -R`, socat) delivers a remote client from
//     127.0.0.1 with spoofed loopback Host/Origin and NO forwarding headers —
//     indistinguishable from a local browser at the socket level. Such a
//     client must not be able to read the exec token from any HTTP response,
//     and must not run commands unless the server opted in to exec.

delete process.env.SERVE_SIM_AUTH_TOKEN;
// The preview HTML is a build-time define; give the source build a stub page.
(globalThis as Record<string, unknown>).__PREVIEW_HTML_B64__ = Buffer.from(
  "<!doctype html><html><head><!--__SIM_PREVIEW_CONFIG__--></head></html>",
).toString("base64");

const EXEC_TOKEN = "exec-attack-secret-token-9f2c";
// No state file exists for this device, so the preview serves the empty-state
// config (the branch that used to inject the token unconditionally on loopback).
const DEVICE = "00000000-0000-0000-0000-0000000000AA";
// The command's output differs from its text, so seeing it proves it ran.
const COMMAND = "echo pwned-$((6*7))";
const RAN = "pwned-42";

interface RawResponse { status: number; raw: string }

/**
 * Write exact request bytes on a fresh loopback TCP connection — what a socat
 * / `ssh -R` forward delivers. Streams (SSE) are cut after a short window.
 */
function rawRequest(
  port: number,
  lines: string[],
  body = "",
  windowMs = 1500,
): Promise<RawResponse> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let raw = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      socket.destroy();
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw)?.[1] ?? 0);
      resolve({ status, raw });
    };
    const timer = setTimeout(finish, windowMs);
    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => { raw += chunk; });
    socket.on("end", () => { clearTimeout(timer); finish(); });
    socket.on("error", () => { clearTimeout(timer); finish(); });
    socket.write(`${lines.join("\r\n")}\r\nConnection: close\r\n\r\n${body}`);
  });
}

function spoofedLoopback(port: number): string[] {
  return [`Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`];
}

function get(port: number, path: string, extra: string[] = []): Promise<RawResponse> {
  return rawRequest(port, [`GET ${path} HTTP/1.1`, ...spoofedLoopback(port), ...extra]);
}

function postExec(port: number, token: string | null, extra: string[] = []): Promise<RawResponse> {
  const body = JSON.stringify({ command: COMMAND });
  return rawRequest(
    port,
    [
      "POST /exec HTTP/1.1",
      ...spoofedLoopback(port),
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      ...(token !== null ? [`Authorization: Bearer ${token}`] : []),
      ...extra,
    ],
    body,
    5000,
  );
}

/** What an attacker would scrape from a page config, if it were there. */
function scrapeExecToken(raw: string): string | null {
  return /"execToken":"([^"]+)"/.exec(raw)?.[1] ?? null;
}

/** Try to run COMMAND over the `/exec-ws` control channel as the page would. */
function wsExec(port: number, token: string): Promise<{ ran: boolean; reply: string }> {
  return new Promise((resolve) => {
    // Host defaults to 127.0.0.1:<port> — the spoofed loopback value.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    let reply = "";
    const done = () => {
      ws.terminate();
      resolve({ ran: reply.includes(RAN), reply });
    };
    const timer = setTimeout(done, 4000);
    ws.on("open", () => ws.send(JSON.stringify({ token })));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as { ready?: boolean };
      if (msg.ready) {
        ws.send(JSON.stringify({ id: 1, command: COMMAND }));
        return;
      }
      reply = String(data);
      clearTimeout(timer);
      done();
    });
    ws.on("close", () => { clearTimeout(timer); done(); });
    ws.on("error", () => { clearTimeout(timer); done(); });
  });
}

/** A side-effect file only a command that actually ran would create. */
const markers: string[] = [];
function marker(): string {
  const path = join(tmpdir(), `serve-sim-attack-${process.pid}-${randomUUID()}`);
  markers.push(path);
  return path;
}

/**
 * A spoofed-loopback control-channel client: open `/exec-ws` with a loopback
 * Origin, send `first` as the opening frame, then exchange frames in order.
 */
function wsSession(port: number, first: Record<string, unknown>): Promise<{
  request: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    const waiters: Array<(m: Record<string, unknown>) => void> = [];
    const timer = setTimeout(() => reject(new Error("no ready")), 4000);
    ws.on("open", () => ws.send(JSON.stringify(first)));
    ws.on("error", reject);
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      if (msg.ready) {
        clearTimeout(timer);
        resolve({
          request: (body) =>
            new Promise((r, rej) => {
              const bail = setTimeout(() => rej(new Error("reply timeout")), 8000);
              waiters.push((m) => { clearTimeout(bail); r(m); });
              ws.send(JSON.stringify(body));
            }),
          close: () => ws.terminate(),
        });
        return;
      }
      waiters.shift()?.(msg);
    });
  });
}

const VALID_UDID = "11111111-2222-3333-4444-555555555555";

// Every GET route a forwarded client could read without side effects.
const READ_ROUTES = [
  "/",
  `/?device=${DEVICE}`,
  "/api",
  "/api/events",
  "/api/event-log",
  "/api/event-log/events",
  "/grid/api/memory",
  `/helper/${DEVICE}/config`,
  "/appstate",
  "/ax",
];

function listen(options: Parameters<typeof simMiddleware>[0]): Promise<{ server: Server; port: number }> {
  const middleware = simMiddleware(options);
  const server = createServer((req, res) => {
    middleware(req, res, async () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end("Not found");
    });
  });
  server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket as Socket, head));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

let execOn: { server: Server; port: number };
let execOff: { server: Server; port: number };

beforeAll(async () => {
  // Every well-formed udid counts as booted here, so the RPC tests prove the
  // param validators (not the device check) stop injection attempts.
  const isKnownDevice = async () => true;
  execOn = await listen({ basePath: "/", execToken: EXEC_TOKEN, device: DEVICE, allowExec: true, isKnownDevice });
  execOff = await listen({ basePath: "/", execToken: EXEC_TOKEN, device: DEVICE, isKnownDevice });
});

afterAll(() => {
  execOn.server.close();
  execOff.server.close();
  for (const path of markers) rmSync(path, { force: true });
});

describe("(a) reverse proxy with spoofed loopback Host/Origin + X-Forwarded-For", () => {
  const NGINX = ["X-Forwarded-For: 203.0.113.7", "X-Real-IP: 203.0.113.7", "X-Forwarded-Proto: http"];

  test("GET / does not contain the exec token", async () => {
    for (const { port } of [execOn, execOff]) {
      const r = await get(port, "/", NGINX);
      expect(r.raw).not.toContain(EXEC_TOKEN);
      expect(r.raw).not.toContain("execToken");
    }
  });

  test("POST /exec is rejected, even with the real token", async () => {
    for (const { port } of [execOn, execOff]) {
      for (const token of [null, EXEC_TOKEN]) {
        const r = await postExec(port, token, NGINX);
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.raw).not.toContain(RAN);
      }
    }
  });
});

describe("(b) ssh -R / socat raw loopback forward with spoofed Host/Origin, no forwarding headers", () => {
  test("no HTTP route returns the exec token or the auth-token fingerprint", async () => {
    for (const { port } of [execOn, execOff]) {
      for (const path of READ_ROUTES) {
        const r = await get(port, path);
        expect({ path, leaked: r.raw.includes(EXEC_TOKEN) }).toEqual({ path, leaked: false });
        expect({ path, field: r.raw.includes("execToken") }).toEqual({ path, field: false });
        expect({ path, fingerprint: r.raw.includes("authTokenSha256") }).toEqual({ path, fingerprint: false });
      }
    }
  }, 60_000);

  test("served state (page config, /api, /api/events) strips the auth-token fingerprint", () => {
    const fingerprint = authTokenFingerprint("server-auth-token")!;
    const state = { ...inProcessServeSimState(DEVICE, 3200), authTokenSha256: fingerprint, allowExec: true };
    const served = [
      previewConfigForState(state, "", "serve-sim", true),
      previewConfigForState(rewriteStateForRequestHost(state, "127.0.0.1:3200", "", "http", true), "", "", false),
      rewriteStateForRequestHost(state, undefined),
      rewriteStateForRequestHost(state, "127.0.0.1:3200"),
      rewriteStateForRequestHost(state, "192.168.1.5:3200"),
      rewriteStateForRequestHost(state, "192.168.1.5:3200", "/.sim", "https", true),
    ];
    for (const value of served) {
      const json = JSON.stringify(value);
      expect(json).not.toContain("authTokenSha256");
      expect(json).not.toContain(fingerprint);
    }
  });

  test("POST /exec without the token is rejected", async () => {
    for (const { port } of [execOn, execOff]) {
      const r = await postExec(port, null);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.raw).not.toContain(RAN);
    }
  });

  test("scraping the page for a token and replaying it does not run commands", async () => {
    for (const { port } of [execOn, execOff]) {
      const page = await get(port, "/");
      const scraped = scrapeExecToken(page.raw) ?? "";
      const r = await postExec(port, scraped);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.raw).not.toContain(RAN);
    }
  });

  test("with exec disabled, even the valid token is rejected", async () => {
    const r = await postExec(execOff.port, EXEC_TOKEN);
    expect(r.status).toBe(403);
    expect(r.raw).toContain("exec disabled; start with --allow-exec");
    expect(r.raw).not.toContain(RAN);
  });

  test("with exec disabled, the control channel refuses commands (scraped or real token)", async () => {
    const page = await get(execOff.port, "/");
    for (const token of [scrapeExecToken(page.raw) ?? "", EXEC_TOKEN]) {
      const result = await wsExec(execOff.port, token);
      expect(result.ran).toBe(false);
    }
  });
});

// Under Bun, servePreview pipes plain HTTP through a TCP front server to an
// internal node:http server on 127.0.0.1; the forwarded client must see the
// same answers through that pipe.
describe.skipIf(!process.versions.bun)("(b) through the Bun front-server pipe", () => {
  const PORT = 3571;
  let preview: PreviewServer;
  beforeAll(async () => {
    const middleware = simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, device: DEVICE });
    preview = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
  });
  afterAll(() => preview?.stop(true));

  test("no token in page or JSON, and exec refused", async () => {
    for (const path of ["/", "/api", "/api/events"]) {
      expect((await get(PORT, path)).raw).not.toContain(EXEC_TOKEN);
    }
    const r = await postExec(PORT, EXEC_TOKEN);
    expect(r.status).toBe(403);
    expect(r.raw).not.toContain(RAN);
  });
});

describe("(b) control channel: shell commands need the exec token, not just loopback", () => {
  test("a spoofed loopback client sending {} cannot run commands, even with exec on", async () => {
    const file = marker();
    const session = await wsSession(execOn.port, {});
    const reply = await session.request({ id: 1, command: `touch ${file}` });
    session.close();
    expect(reply.exitCode).toBe(126);
    expect(reply.error).toBe("exec requires the exec token");
    await Bun.sleep(200);
    expect(existsSync(file)).toBe(false);
  });

  test("a wrong or scraped token does not unlock commands", async () => {
    const page = await get(execOn.port, "/");
    for (const token of [scrapeExecToken(page.raw) ?? "", "x".repeat(EXEC_TOKEN.length), `${EXEC_TOKEN}x`, 42]) {
      const file = marker();
      const session = await wsSession(execOn.port, { token });
      const reply = await session.request({ id: 1, command: `touch ${file}` });
      session.close();
      expect(reply.exitCode).toBe(126);
      expect(existsSync(file)).toBe(false);
    }
  });

  test("the token is only accepted on the first frame", async () => {
    const file = marker();
    const session = await wsSession(execOn.port, {});
    const reply = await session.request({ id: 1, token: EXEC_TOKEN, command: `touch ${file}` });
    session.close();
    expect(reply.exitCode).toBe(126);
    expect(existsSync(file)).toBe(false);
  });

  test("with the real token (from the owner-only file) the command runs", async () => {
    const file = marker();
    const session = await wsSession(execOn.port, { token: EXEC_TOKEN });
    const reply = await session.request({ id: 1, command: `touch ${file}` });
    session.close();
    expect(reply.exitCode).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});

describe("(b) host actions validate params and never reach a shell", () => {
  // Each payload would create the marker if any part reached `sh -c`.
  function injections(file: string): Array<{ method: string; params: Record<string, unknown>; error: RegExp }> {
    const sh = `'; touch ${file}; '`;
    return [
      { method: "home", params: { udid: `'; touch ${file}` }, error: /invalid udid/ },
      { method: "screenshot", params: { udid: `$(touch ${file})` }, error: /invalid udid/ },
      { method: "screenshot", params: { udid: VALID_UDID, display: `primary; touch ${file}` }, error: /invalid display/ },
      { method: "toggleAppearance", params: { udid: `${VALID_UDID}\`touch ${file}\`` }, error: /invalid udid/ },
      { method: "appDetails", params: { udid: VALID_UDID, bundleId: `com.x;touch ${file}` }, error: /invalid bundle id/ },
      { method: "revealApp", params: { udid: VALID_UDID, bundleId: `com.x$(touch ${file})` }, error: /invalid bundle id/ },
      { method: "permissions", params: { udid: VALID_UDID, bundleId: `com.x|touch ${file}`, action: "grant", service: "camera" }, error: /invalid bundle id/ },
      { method: "permissions", params: { udid: VALID_UDID, bundleId: "com.x", action: "grant", service: `camera; touch ${file}` }, error: /invalid service/ },
      { method: "permissions", params: { udid: VALID_UDID, bundleId: "com.x", action: `grant && touch ${file}`, service: "camera" }, error: /invalid action/ },
      { method: "permissions", params: { udid: VALID_UDID, bundleId: "--help", action: "grant", service: "camera" }, error: /invalid bundle id/ },
      { method: "cameraInject", params: { udid: VALID_UDID, bundleId: "com.x", source: "webcam", webcamId: `-x\n${sh}`, mirror: "off" }, error: /invalid webcamId/ },
      { method: "cameraInject", params: { udid: VALID_UDID, bundleId: "com.x", source: "image", filePath: `/tmp/a${sh}`, mirror: "off" }, error: /invalid filePath/ },
      { method: "cameraSwitch", params: { udid: VALID_UDID, source: `file ${sh}` }, error: /invalid source/ },
      { method: "cameraMirror", params: { udid: VALID_UDID, mirror: `on${sh}` }, error: /invalid mirror/ },
      { method: "location", params: { udid: VALID_UDID, lat: `1;touch ${file}`, lng: 2 }, error: /invalid lat/ },
      { method: "addMedia", params: { udid: VALID_UDID, path: "/etc/passwd" }, error: /invalid path/ },
      { method: "addMedia", params: { udid: VALID_UDID, path: `/tmp/serve-sim-upload-${randomUUID()}.png${sh}` }, error: /invalid path/ },
      { method: "installApp", params: { udid: VALID_UDID, path: `/tmp/serve-sim-install-${randomUUID()}.png` }, error: /invalid path/ },
      { method: "revealScreenshot", params: { path: `${tmpdir()}/../../etc/serve-sim-screenshot-x.png` }, error: /invalid path/ },
      { method: "screenshotThumbnail", params: { path: `/tmp/serve-sim-screenshot-$(touch ${file}).png` }, error: /invalid path/ },
      { method: "uploadChunk", params: { path: `/tmp/serve-sim-upload-../../${file}`, data: "AA==" }, error: /invalid path/ },
      { method: "uploadChunk", params: { path: `/tmp/serve-sim-upload-${randomUUID()}.bin`, data: `$(touch ${file})` }, error: /invalid data/ },
      { method: "exec", params: { command: `touch ${file}` }, error: /unknown method/ },
      { method: "constructor", params: {}, error: /unknown method/ },
    ];
  }

  test("injection attempts are rejected and nothing runs (exec on and off)", async () => {
    for (const { port } of [execOn, execOff]) {
      const file = marker();
      const session = await wsSession(port, {});
      let id = 1;
      for (const attempt of injections(file)) {
        const reply = await session.request({ id: id++, rpc: { method: attempt.method, params: attempt.params } });
        expect({ method: attempt.method, error: String(reply.error ?? "") }).toEqual({
          method: attempt.method,
          error: expect.stringMatching(attempt.error),
        });
      }
      session.close();
      await Bun.sleep(200);
      expect(existsSync(file)).toBe(false);
    }
  });

  test("uploads work without --allow-exec, confined to their own fresh file", async () => {
    const path = `/tmp/serve-sim-upload-${randomUUID()}.bin`;
    markers.push(path);
    const session = await wsSession(execOff.port, {});
    const data = (text: string) => Buffer.from(text).toString("base64");
    expect((await session.request({ id: 1, rpc: { method: "uploadChunk", params: { path, data: data("hello ") } } })).ok).toBe(true);
    expect((await session.request({ id: 2, rpc: { method: "uploadChunk", params: { path, data: data("world"), append: true } } })).ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("hello world");
    // A second "create" must not clobber an existing file.
    const again = await session.request({ id: 3, rpc: { method: "uploadChunk", params: { path, data: data("x") } } });
    expect(String(again.error)).toMatch(/EEXIST/);
    await session.request({ id: 4, rpc: { method: "uploadRemove", params: { path } } });
    expect(existsSync(path)).toBe(false);
    session.close();
  });

  test("an upload path pre-planted as a symlink is not followed", async () => {
    const target = marker();
    const path = `/tmp/serve-sim-upload-${randomUUID()}.bin`;
    markers.push(path);
    symlinkSync(target, path);
    const session = await wsSession(execOff.port, {});
    const data = Buffer.from("owned").toString("base64");
    for (const append of [false, true]) {
      const reply = await session.request({ id: 1, rpc: { method: "uploadChunk", params: { path, data, append } } });
      expect(reply.error).toBeTruthy();
    }
    session.close();
    expect(existsSync(target)).toBe(false);
  });
});
