import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { createServer, request, type Server } from "http";
import { connect, type AddressInfo, type Socket } from "net";
import { networkInterfaces } from "os";
import { join } from "path";
import WebSocket from "ws";
import { simMiddleware } from "../middleware";
import {
  AUTH_COOKIE,
  authCookieValue,
  hasForwardingHeaders,
  isLoopbackSameOrigin,
  isTrustedLoopback,
  registerProxiedPeer,
  remoteAccess,
} from "../request-trust";
import { servePreview, type PreviewServer } from "../runtime";

// Remote access model: only a trusted loopback request (loopback peer, no
// proxy headers, loopback Host) is local. Everything else needs the auth
// token, and the host shell is loopback-only no matter what.

delete process.env.SERVE_SIM_AUTH_TOKEN;
// The preview HTML is a build-time define; give the source build a stub page.
(globalThis as Record<string, unknown>).__PREVIEW_HTML_B64__ = Buffer.from(
  "<!doctype html><html><head><!--__SIM_PREVIEW_CONFIG__--></head></html>",
).toString("base64");

const EXEC_TOKEN = "exec-token-for-tests";
const AUTH_TOKEN = "remote-auth-token-for-tests";
// Pinned to a device that has no state file, so the preview serves the
// minimal empty-state config.
const DEVICE = "00000000-0000-0000-0000-000000000000";
const PROXY = { "X-Forwarded-For": "203.0.113.7", "X-Forwarded-Proto": "https" };

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function send(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: opts.host ?? "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        // SSE routes never end; one chunk is enough.
        res.on("data", (chunk: string) => {
          body += chunk;
          if (String(res.headers["content-type"]).includes("event-stream")) {
            req.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

interface RawRes {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Decode a chunked body. Returns null until the terminating chunk has arrived. */
function decodeChunked(body: Buffer): string | null {
  let offset = 0;
  const parts: Buffer[] = [];
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) return null;
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString("latin1").split(";")[0]!.trim(), 16);
    if (!Number.isFinite(size) || size < 0) return null;
    const dataStart = lineEnd + 2;
    if (size === 0) return Buffer.concat(parts).toString("utf8");
    if (body.length < dataStart + size + 2) return null;
    parts.push(body.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2;
  }
  return null;
}

/**
 * Write an HTTP request as exact bytes over a raw TCP socket.
 * `0` means the peer closed without a status line; `-1` means the 4000ms timeout.
 */
function rawRequest(
  port: number,
  target: string,
  headers: Record<string, string> = {},
  opts: { method?: string; body?: string; host?: string } = {},
): Promise<RawRes> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect(port, opts.host ?? "127.0.0.1");
    let buf = Buffer.alloc(0);
    const finish = (result: RawRes) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: -1, headers: {}, body: "" }), 4000);

    const parse = (force: boolean): RawRes | null => {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return null;
      const lines = buf.subarray(0, headerEnd).toString("latin1").split("\r\n");
      const status = Number(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})/.exec(lines.shift() ?? "")?.[1]);
      if (!Number.isFinite(status)) return force ? { status: 0, headers: {}, body: "" } : null;
      const responseHeaders: Record<string, string | string[]> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        const existing = responseHeaders[name];
        if (existing === undefined) responseHeaders[name] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else responseHeaders[name] = [existing, value];
      }
      const rest = buf.subarray(headerEnd + 4);
      if (status === 101) return { status, headers: responseHeaders, body: rest.toString("utf8") };
      const transfer = responseHeaders["transfer-encoding"];
      const transferValue = Array.isArray(transfer) ? transfer.join(",") : transfer ?? "";
      if (/chunked/i.test(transferValue)) {
        const decoded = decodeChunked(rest);
        if (decoded === null) {
          return force ? { status, headers: responseHeaders, body: rest.toString("utf8") } : null;
        }
        return { status, headers: responseHeaders, body: decoded };
      }
      const lengthHeader = responseHeaders["content-length"];
      const lengthValue = Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader;
      if (lengthValue !== undefined && lengthValue !== "") {
        const length = Number(lengthValue);
        if (!Number.isFinite(length) || rest.length < length) {
          return force ? { status, headers: responseHeaders, body: rest.toString("utf8") } : null;
        }
        return { status, headers: responseHeaders, body: rest.subarray(0, length).toString("utf8") };
      }
      if (!force) return null;
      return { status, headers: responseHeaders, body: rest.toString("utf8") };
    };

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parse(false);
      if (parsed) finish(parsed);
    });
    socket.on("error", () => {
      if (buf.length === 0) finish({ status: 0, headers: {}, body: "" });
    });
    socket.on("close", () => {
      const parsed = parse(true);
      finish(parsed ?? { status: 0, headers: {}, body: "" });
    });

    const method = opts.method ?? "GET";
    const provided = new Map(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), { name, value }] as const),
    );
    const lines = [`${method} ${target} HTTP/1.1`];
    if (!provided.has("host")) lines.push(`Host: ${opts.host ?? "127.0.0.1"}`);
    for (const { name, value } of provided.values()) lines.push(`${name}: ${value}`);
    if (!provided.has("connection")) lines.push("Connection: close");
    if (opts.body != null && opts.body !== "" && !provided.has("content-length")) {
      lines.push(`Content-Length: ${Buffer.byteLength(opts.body)}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n${opts.body ?? ""}`);
  });
}

/**
 * Attempt a WebSocket upgrade by writing the handshake bytes directly.
 * `"open"` is a 101; otherwise the HTTP status (`0` = close with no status, `-1` = timeout).
 */
function upgrade(url: string, headers: Record<string, string> = {}, host?: string): Promise<"open" | number> {
  const parsed = new URL(url);
  const requestHeaders: Record<string, string> = {
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    ...headers,
  };
  if (host) requestHeaders.Host = host;
  return rawRequest(Number(parsed.port), `${parsed.pathname}${parsed.search}`, requestHeaders, {
    host: parsed.hostname,
  }).then((res) => (res.status === 101 ? "open" : res.status));
}

/**
 * Bun 1.3's node:http upgrade socket swallows the rejection status line (the
 * peer closes and the client sees `0`). A timeout (`-1`) is never a refusal.
 * `0` counts only while {@link upgradeRejectionsVisible} is false.
 */
function expectUpgradeRefused(status: "open" | number, code: number): void {
  if (!upgradeRejectionsVisible && status === 0) return;
  expect(status).toBe(code);
}

/** True when a refused upgrade on the node:http server returns a real status. */
async function probeUpgradeRejectionVisible(): Promise<boolean> {
  const status = await upgrade(`ws://127.0.0.1:${noToken.port}/helper/${DEVICE}/ws`, PROXY);
  return typeof status === "number" && status >= 100;
}

function listen(authToken?: string): Promise<{ server: Server; port: number }> {
  const middleware = simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, allowExec: true, device: DEVICE, authToken });
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

let withToken: { server: Server; port: number };
let noToken: { server: Server; port: number };
// Set in beforeAll. False only on Bun 1.3.x, where node:http upgrade writes
// do not flush a rejection status (the front server still does).
let upgradeRejectionsVisible = false;

beforeAll(async () => {
  withToken = await listen(AUTH_TOKEN);
  noToken = await listen(undefined);
  upgradeRejectionsVisible = await probeUpgradeRejectionVisible();
  if (!upgradeRejectionsVisible && !/^1\.3\./.test(process.versions.bun ?? "")) {
    throw new Error(
      `WebSocket upgrade rejections are not visible on ${process.versions.bun ? `bun ${process.versions.bun}` : "this runtime"}; only Bun 1.3.x may hide them`,
    );
  }
});

/** Drop open (keep-alive) connections and wait for the listener to close. */
function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

afterAll(async () => {
  await Promise.all([closeServer(withToken?.server), closeServer(noToken?.server)]);
});

const bearer = { Authorization: `Bearer ${AUTH_TOKEN}` };

describe("request trust classification", () => {
  const sock = (remoteAddress: string, remotePort = 50000) => ({ remoteAddress, remotePort }) as never;

  test("loopback peer + loopback Host + no proxy headers is trusted", () => {
    for (const host of ["127.0.0.1:3200", "localhost:3200", "[::1]:3200"]) {
      expect(isTrustedLoopback({ socket: sock("127.0.0.1"), headers: { host } })).toBe(true);
    }
    expect(isTrustedLoopback({ socket: sock("::ffff:127.0.0.1"), headers: { host: "localhost" } })).toBe(true);
  });

  test("proxy and tunnel headers make a loopback peer untrusted", () => {
    for (const header of [
      "x-forwarded-for", "x-forwarded-host", "forwarded", "via", "x-real-ip",
      "cf-connecting-ip", "true-client-ip", "tailscale-user-login", "ngrok-skip-browser-warning",
    ]) {
      expect(hasForwardingHeaders({ [header]: "x" })).toBe(true);
      expect(isTrustedLoopback({ socket: sock("127.0.0.1"), headers: { host: "127.0.0.1:3200", [header]: "x" } })).toBe(false);
    }
  });

  test("a non-loopback Host (DNS rebinding, tunnel host) is untrusted", () => {
    expect(isTrustedLoopback({ socket: sock("127.0.0.1"), headers: { host: "attacker.example:3200" } })).toBe(false);
    expect(isTrustedLoopback({ socket: sock("127.0.0.1"), headers: {} })).toBe(false);
  });

  test("a LAN peer is untrusted", () => {
    expect(isTrustedLoopback({ socket: sock("192.168.1.20"), headers: { host: "localhost:3200" } })).toBe(false);
  });

  test("a peer recorded by the Bun front proxy overrides the loopback pipe", () => {
    const unregister = registerProxiedPeer(61234, "192.168.1.20");
    try {
      expect(isTrustedLoopback({ socket: sock("127.0.0.1", 61234), headers: { host: "localhost:3200" } })).toBe(false);
    } finally {
      unregister();
    }
    expect(isTrustedLoopback({ socket: sock("127.0.0.1", 61234), headers: { host: "localhost:3200" } })).toBe(true);
  });

  test("loopback same-origin requires a loopback Origin that matches Host", () => {
    expect(isLoopbackSameOrigin({ headers: { host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200" } })).toBe(true);
    expect(isLoopbackSameOrigin({ headers: { host: "127.0.0.1:3200" } })).toBe(false);
    expect(isLoopbackSameOrigin({ headers: { host: "127.0.0.1:3200", origin: "http://evil.example" } })).toBe(false);
    expect(isLoopbackSameOrigin({ headers: { host: "x.example", origin: "http://x.example" } })).toBe(false);
  });

  test("remote access: no configured token is 403, wrong token 401, bearer or cookie ok", () => {
    expect(remoteAccess({ headers: {} }, undefined)).toMatchObject({ ok: false, status: 403 });
    expect(remoteAccess({ headers: { authorization: "Bearer nope" } }, AUTH_TOKEN)).toMatchObject({ ok: false, status: 401 });
    expect(remoteAccess({ headers: { authorization: `Bearer ${AUTH_TOKEN}` } }, AUTH_TOKEN)).toEqual({ ok: true });
    expect(remoteAccess({ headers: { cookie: `a=b; ${AUTH_COOKIE}=${authCookieValue(AUTH_TOKEN)}` } }, AUTH_TOKEN)).toEqual({ ok: true });
    expect(remoteAccess({ headers: { cookie: `${AUTH_COOKIE}=${AUTH_TOKEN}` } }, AUTH_TOKEN)).toMatchObject({ ok: false });
  });
});

describe("exec token is never handed to remote callers", () => {
  test("loopback preview HTML never carries the exec token", async () => {
    const r = await send(withToken.port, "/");
    expect(r.status).toBe(200);
    expect(r.body).toContain(`"allowExec":true`);
    expect(r.body).not.toContain("execToken");
    expect(r.body).not.toContain(EXEC_TOKEN);
  });

  test("proxied preview HTML is refused without the auth token", async () => {
    expect((await send(noToken.port, "/", { headers: PROXY })).status).toBe(403);
    expect((await send(withToken.port, "/", { headers: PROXY })).status).toBe(401);
  });

  test("authenticated remote preview HTML omits the exec token and binary path", async () => {
    const r = await send(withToken.port, "/", { headers: { ...PROXY, ...bearer } });
    expect(r.status).toBe(200);
    expect(r.body).not.toContain("execToken");
    expect(r.body).not.toContain(EXEC_TOKEN);
  });

  test("rebound Host is treated as remote", async () => {
    expect((await send(noToken.port, "/", { headers: { Host: "attacker.example" } })).status).toBe(403);
    expect((await send(noToken.port, "/api", { headers: { Host: "attacker.example" } })).status).toBe(403);
  });

  test("/api and /api/events never include the exec token, even on loopback", async () => {
    for (const path of ["/api", "/api/events"]) {
      const local = await send(withToken.port, path);
      expect(local.status).toBe(200);
      expect(local.body).not.toContain(EXEC_TOKEN);
      expect((await send(noToken.port, path, { headers: PROXY })).status).toBe(403);
      const remote = await send(withToken.port, path, { headers: { ...PROXY, ...bearer } });
      expect(remote.status).toBe(200);
      expect(remote.body).not.toContain(EXEC_TOKEN);
    }
  });
});

describe("/exec is loopback-only", () => {
  const exec = (port: number, headers: Record<string, string>) =>
    send(port, "/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${EXEC_TOKEN}`, ...headers },
      body: JSON.stringify({ command: "echo should-not-run" }),
    });

  test("no Origin is refused", async () => {
    const r = await exec(withToken.port, {});
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("should-not-run");
  });

  test("proxied request is refused even with the auth token and a matching Origin", async () => {
    const origin = `http://127.0.0.1:${withToken.port}`;
    const r = await send(withToken.port, "/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...PROXY, ...bearer, Origin: origin },
      body: JSON.stringify({ command: "echo should-not-run" }),
    });
    expect(r.status).toBe(403);
    expect(r.body).not.toContain("should-not-run");
    expect((await exec(noToken.port, { ...PROXY, Origin: origin })).status).toBe(403);
  });

  test("loopback page with Origin and exec token still works", async () => {
    const r = await send(withToken.port, "/exec", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${EXEC_TOKEN}`,
        Origin: `http://127.0.0.1:${withToken.port}`,
      },
      body: JSON.stringify({ command: "echo loopback-ok" }),
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).stdout.trim()).toBe("loopback-ok");
  });
});

describe("grid, DevTools, and helper routes require auth remotely", () => {
  test("grid start/shutdown: remote without token refused, cross-origin refused on loopback", async () => {
    for (const path of ["/grid/api/start", "/grid/api/shutdown"]) {
      const body = JSON.stringify({ udid: "not-a-udid" });
      const json = { "Content-Type": "application/json" };
      expect((await send(noToken.port, path, { method: "POST", headers: { ...json, ...PROXY }, body })).status).toBe(403);
      expect((await send(withToken.port, path, { method: "POST", headers: { ...json, ...PROXY }, body })).status).toBe(401);
      expect((await send(withToken.port, path, { method: "POST", headers: { ...json, Origin: "http://evil.example" }, body })).status).toBe(403);
      // Authenticated remote reaches the handler (which rejects the bad udid).
      expect((await send(withToken.port, path, { method: "POST", headers: { ...json, ...PROXY, ...bearer }, body })).status).toBe(400);
    }
  });

  test("DevTools and helper HTTP routes are refused remotely without the token", async () => {
    for (const path of ["/devtools", `/helper/${DEVICE}/config`, `/helper/${DEVICE}/stream.mjpeg`, "/api/event-log", "/grid/api"]) {
      expect((await send(noToken.port, path, { headers: PROXY })).status).toBe(403);
      expect((await send(withToken.port, path, { headers: PROXY })).status).toBe(401);
    }
  });

  test("HID and DevTools WebSocket upgrades require the token remotely and a same-origin Origin", async () => {
    for (const port of [noToken.port, withToken.port]) {
      for (const path of [`/helper/${DEVICE}/ws`, "/devtools/page/1"]) {
        const status = await upgrade(`ws://127.0.0.1:${port}${path}`, PROXY);
        expectUpgradeRefused(status, port === noToken.port ? 403 : 401);
        expectUpgradeRefused(
          await upgrade(`ws://127.0.0.1:${port}${path}`, { Origin: "http://evil.example" }),
          403,
        );
      }
    }
    // Authenticated remote passes the auth gate (what happens next depends on
    // the device; here it is not real). A timeout is not a refusal.
    const authed = await upgrade(`ws://127.0.0.1:${withToken.port}/helper/${DEVICE}/ws`, { ...PROXY, ...bearer });
    expect(authed).not.toBe(401);
    expect(authed).not.toBe(403);
    expect(authed).not.toBe(-1);
  });

  test("helper responses no longer send a wildcard CORS header", () => {
    const source = readFileSync(join(import.meta.dir, "..", "device-session.ts"), "utf-8");
    expect(source).not.toContain("Access-Control-Allow-Origin");
  });
});

describe("control channel (/exec-ws)", () => {
  function channel(port: number, headers: Record<string, string>, token: string): Promise<{
    first: unknown; ws: WebSocket; next: () => Promise<Record<string, unknown>>;
  } | "closed"> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, { headers });
      const queue: Array<Record<string, unknown>> = [];
      const waiters: Array<(m: Record<string, unknown>) => void> = [];
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        const w = waiters.shift();
        if (w) w(msg); else queue.push(msg);
      });
      const next = () => new Promise<Record<string, unknown>>((r) => {
        const q = queue.shift();
        if (q) r(q); else waiters.push(r);
      });
      ws.on("open", async () => {
        ws.send(JSON.stringify({ token }));
        resolve({ first: await next(), ws, next });
      });
      ws.on("close", () => resolve("closed"));
      ws.on("error", () => resolve("closed"));
      ws.on("unexpected-response", () => resolve("closed"));
    });
  }

  test("an upgrade without Origin is refused", async () => {
    expect(await channel(withToken.port, {}, EXEC_TOKEN)).toBe("closed");
  });

  test("a proxied upgrade without the auth token is refused", async () => {
    const origin = { Origin: `http://127.0.0.1:${noToken.port}` };
    expect(await channel(noToken.port, { ...origin, ...PROXY }, EXEC_TOKEN)).toBe("closed");
  });

  test("an authenticated remote socket gets SSE/settings but cannot exec", async () => {
    const c = await channel(withToken.port, { Origin: `http://127.0.0.1:${withToken.port}`, ...PROXY, ...bearer }, "");
    expect(c).not.toBe("closed");
    if (c === "closed") return;
    expect(c.first).toEqual({ ready: true });
    c.ws.send(JSON.stringify({ id: 1, command: "echo should-not-run" }));
    const reply = await c.next();
    expect(reply.exitCode).toBe(126);
    expect(String(reply.stdout)).not.toContain("should-not-run");
    c.ws.close();
  });

  test("the token-less loopback page cannot exec, even with allowExec", async () => {
    const c = await channel(withToken.port, { Origin: `http://127.0.0.1:${withToken.port}` }, "");
    expect(c).not.toBe("closed");
    if (c === "closed") return;
    c.ws.send(JSON.stringify({ id: 2, command: "echo should-not-run" }));
    const reply = await c.next();
    expect(reply.exitCode).toBe(126);
    expect(String(reply.stdout)).not.toContain("should-not-run");
    c.ws.close();
  });

  test("a loopback socket holding the exec token can exec (allowExec)", async () => {
    const c = await channel(withToken.port, { Origin: `http://127.0.0.1:${withToken.port}` }, EXEC_TOKEN);
    expect(c).not.toBe("closed");
    if (c === "closed") return;
    c.ws.send(JSON.stringify({ id: 3, command: "echo loopback-channel-ok" }));
    const reply = await c.next();
    expect(String(reply.stdout).trim()).toBe("loopback-channel-ok");
    c.ws.close();
  });

  test("an authenticated remote socket cannot run host actions", async () => {
    const c = await channel(withToken.port, { Origin: `http://127.0.0.1:${withToken.port}`, ...PROXY, ...bearer }, "");
    expect(c).not.toBe("closed");
    if (c === "closed") return;
    c.ws.send(JSON.stringify({ id: 4, rpc: { method: "cameraListWebcams", params: {} } }));
    const reply = await c.next();
    expect(reply.error).toBe("host actions are only available to loopback clients");
    c.ws.close();
  });
});

describe("remote browser cookie bootstrap", () => {
  test("?token= on the preview page sets an HttpOnly cookie and redirects", async () => {
    const r = await send(withToken.port, `/?token=${AUTH_TOKEN}&device=${DEVICE}`, { headers: PROXY });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`/?device=${DEVICE}`);
    const cookie = String(r.headers["set-cookie"]);
    expect(cookie).toContain(`${AUTH_COOKIE}=${authCookieValue(AUTH_TOKEN)}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    const api = await send(withToken.port, "/api", {
      headers: { ...PROXY, Cookie: `${AUTH_COOKIE}=${authCookieValue(AUTH_TOKEN)}` },
    });
    expect(api.status).toBe(200);
  });

  test("a wrong ?token= is just unauthorized", async () => {
    expect((await send(withToken.port, "/?token=wrong", { headers: PROXY })).status).toBe(401);
  });
});


// Embedded mounts (Metro/Expo at `/.sim`) must gate on the same normalized
// pathname the helper/devtools routers use — otherwise `/x/../.sim/...` and
// `//host/.sim/...` skip the auth token (N2).
describe("embedded basePath remote gate", () => {
  const EMBED_BASE = "/.sim";
  let embedded: { server: Server; port: number };

  function listenEmbedded(authToken?: string): Promise<{ server: Server; port: number }> {
    const middleware = simMiddleware({
      basePath: EMBED_BASE,
      execToken: EXEC_TOKEN,
      device: DEVICE,
      authToken,
    });
    const server = createServer((req, res) => {
      middleware(req, res, async () => {
        if (!res.headersSent) res.statusCode = 404;
        res.end("host-app");
      });
    });
    server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket as Socket, head));
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () =>
        resolve({ server, port: (server.address() as AddressInfo).port }),
      );
    });
  }

  beforeAll(async () => {
    embedded = await listenEmbedded(AUTH_TOKEN);
  });
  afterAll(() => closeServer(embedded?.server));

  const helperConfig = `${EMBED_BASE}/helper/${DEVICE}/config`;
  const bypassPaths = [
    `/x/..${helperConfig}`,
    `/foo/bar/../..${helperConfig}`,
    `//evil${helperConfig}`,
    `/%2e%2e${helperConfig}`,
  ];

  test("canonical helper path is refused remotely without the token", async () => {
    expect((await send(embedded.port, helperConfig, { headers: PROXY })).status).toBe(401);
  });

  test("dot-segment, absolute-form and %2e%2e targets are gated", async () => {
    for (const path of bypassPaths) {
      // Exact request-target bytes: Bun's HTTP client rewrites `//evil/...`
      // to `/evil/...` before the server sees it.
      const r = await rawRequest(embedded.port, path, PROXY);
      expect({ path, status: r.status }).toEqual({ path, status: 401 });
    }
  });

  test("canonical helper path works with the token", async () => {
    const r = await send(embedded.port, helperConfig, {
      headers: { ...PROXY, Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    // No live session → empty config JSON (or 404); never unauthorized.
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  test("the host app's own routes are untouched", async () => {
    expect((await send(embedded.port, "/host-only", { headers: PROXY })).status).toBe(404);
    expect((await send(embedded.port, "/host-only")).body).toBe("host-app");
  });
});

// Under Bun, servePreview pipes plain HTTP through a TCP front server, so the
// internal server's peer is always 127.0.0.1. A real LAN connection must still
// be classified as remote.
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

describe.skipIf(!lanAddress || !process.versions.bun)("Bun front server keeps the real peer", () => {
  let PORT = 0;
  let preview: PreviewServer;
  beforeAll(async () => {
    const middleware = simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, device: DEVICE, authToken: AUTH_TOKEN });
    preview = await servePreview({ port: 0, middleware, host: "0.0.0.0" });
    PORT = preview.port;
  });
  afterAll(() => preview?.stop(true));

  test("LAN peer needs the token; loopback does not", async () => {
    expect((await send(PORT, "/api", { host: lanAddress, headers: { Host: "localhost" } })).status).toBe(401);
    expect((await send(PORT, "/api", { host: lanAddress, headers: { Host: "localhost", ...bearer } })).status).toBe(200);
    expect((await send(PORT, "/api")).status).toBe(200);
    const html = await send(PORT, "/", { host: lanAddress, headers: { Host: "localhost", ...bearer } });
    expect(html.body).not.toContain(EXEC_TOKEN);
  });

  test("LAN peer cannot open the HID socket without the token", async () => {
    expect(await upgrade(`ws://${lanAddress}:${PORT}/helper/${DEVICE}/ws`, {}, "localhost")).toBe(401);
  });
});

// servePreview's TCP front server writes the rejection itself, so the status
// line is visible on Bun 1.3 even when node:http upgrade sockets swallow it.
describe.skipIf(!process.versions.bun)("Bun front server shows upgrade rejection statuses", () => {
  let PORT_AUTH = 0;
  let PORT_OPEN = 0;
  let withAuth: PreviewServer;
  let noAuth: PreviewServer;

  beforeAll(async () => {
    withAuth = await servePreview({
      port: 0,
      host: "127.0.0.1",
      middleware: simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, device: DEVICE, authToken: AUTH_TOKEN }),
    });
    noAuth = await servePreview({
      port: 0,
      host: "127.0.0.1",
      middleware: simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, device: DEVICE }),
    });
    PORT_AUTH = withAuth.port;
    PORT_OPEN = noAuth.port;
  });
  afterAll(async () => {
    await Promise.all([withAuth?.stop(true), noAuth?.stop(true)]);
  });

  test("remote-without-token and cross-origin upgrades return exact 401/403", async () => {
    for (const path of [`/helper/${DEVICE}/ws`, "/devtools/page/1"]) {
      expect(await upgrade(`ws://127.0.0.1:${PORT_AUTH}${path}`, PROXY)).toBe(401);
      expect(await upgrade(`ws://127.0.0.1:${PORT_OPEN}${path}`, PROXY)).toBe(403);
      expect(await upgrade(`ws://127.0.0.1:${PORT_AUTH}${path}`, { Origin: "http://evil.example" })).toBe(403);
    }
  });
});

describe("exec channel default is fail-closed for embedders", () => {
  let PORT_DEFAULT = 0;
  let srv: Server;
  beforeAll(async () => {
    const { createExecUpgradeHandler } = await import("../exec-ws");
    // No allowShell passed: the default must be loopback + same-origin only.
    const handle = createExecUpgradeHandler({ path: "/exec-ws", allowExec: true, execToken: "embed-token" });
    srv = createServer((_req, res) => res.end());
    srv.on("upgrade", (req, socket, head) => {
      if (!handle(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    PORT_DEFAULT = (srv.address() as AddressInfo).port;
  });
  afterAll(() => closeServer(srv));

  function run(headers: Record<string, string>, token = "embed-token"): Promise<string> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT_DEFAULT}/exec-ws`, { headers });
      const done = (v: string) => {
        ws.terminate();
        resolve(v);
      };
      setTimeout(() => done("timeout"), 3000);
      ws.on("error", () => done("refused"));
      ws.on("open", () => ws.send(JSON.stringify({ token })));
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as { ready?: boolean; exitCode?: number };
        if (msg.ready) ws.send(JSON.stringify({ id: 1, command: "echo default-ok" }));
        else done(`exit ${msg.exitCode}`);
      });
    });
  }

  test("no Origin is refused", async () => {
    expect(await run({})).toBe("refused");
  });
  test("forwarded same-origin upgrade cannot exec", async () => {
    expect(await run({ Origin: `http://127.0.0.1:${PORT_DEFAULT}`, "X-Forwarded-For": "203.0.113.7" })).toBe("exit 126");
  });
  test("loopback same-origin upgrade can exec with the token", async () => {
    expect(await run({ Origin: `http://127.0.0.1:${PORT_DEFAULT}` })).toBe("exit 0");
  });
  test("loopback same-origin upgrade without the token cannot exec", async () => {
    expect(await run({ Origin: `http://127.0.0.1:${PORT_DEFAULT}` }, "")).toBe("exit 126");
  });
});
