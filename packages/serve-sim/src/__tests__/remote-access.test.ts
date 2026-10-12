import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { createServer, request, type Server } from "http";
import type { AddressInfo, Socket } from "net";
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
// minimal empty-state config (which still carries the exec token locally).
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

/** Attempt a WebSocket upgrade; resolve with "open" or the HTTP status. */
function upgrade(url: string, headers: Record<string, string> = {}, host?: string): Promise<"open" | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, ...(host ? { host } : {}) } as never);
    const timer = setTimeout(() => { ws.terminate(); resolve(-1); }, 4000);
    ws.on("open", () => { clearTimeout(timer); ws.close(); resolve("open"); });
    ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); resolve(res.statusCode ?? 0); });
    ws.on("error", () => { clearTimeout(timer); resolve(0); });
  });
}

function listen(authToken?: string): Promise<{ server: Server; port: number }> {
  const middleware = simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, device: DEVICE, authToken });
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

beforeAll(async () => {
  withToken = await listen(AUTH_TOKEN);
  noToken = await listen(undefined);
});

afterAll(() => {
  withToken.server.close();
  noToken.server.close();
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
  test("loopback preview HTML still carries the exec token", async () => {
    const r = await send(withToken.port, "/");
    expect(r.status).toBe(200);
    expect(r.body).toContain(`"execToken":"${EXEC_TOKEN}"`);
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
        expect(status).toBe(port === noToken.port ? 403 : 401);
        expect(await upgrade(`ws://127.0.0.1:${port}${path}`, { Origin: "http://evil.example" })).toBe(403);
      }
    }
    // Authenticated remote passes the auth gate (what happens next depends on
    // the device; here it is not real).
    const authed = await upgrade(`ws://127.0.0.1:${withToken.port}/helper/${DEVICE}/ws`, { ...PROXY, ...bearer });
    expect(authed).not.toBe(401);
    expect(authed).not.toBe(403);
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

  test("the loopback page with the exec token can still exec", async () => {
    const c = await channel(withToken.port, { Origin: `http://127.0.0.1:${withToken.port}` }, EXEC_TOKEN);
    expect(c).not.toBe("closed");
    if (c === "closed") return;
    c.ws.send(JSON.stringify({ id: 2, command: "echo loopback-channel-ok" }));
    const reply = await c.next();
    expect(String(reply.stdout).trim()).toBe("loopback-channel-ok");
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

// Under Bun, servePreview pipes plain HTTP through a TCP front server, so the
// internal server's peer is always 127.0.0.1. A real LAN connection must still
// be classified as remote.
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

describe.skipIf(!lanAddress || !process.versions.bun)("Bun front server keeps the real peer", () => {
  const PORT = 3562;
  let preview: PreviewServer;
  beforeAll(async () => {
    const middleware = simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, device: DEVICE, authToken: AUTH_TOKEN });
    preview = await servePreview({ port: PORT, middleware, host: "0.0.0.0" });
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

describe("exec channel default is fail-closed for embedders", () => {
  const PORT_DEFAULT = 3563;
  let srv: Server;
  beforeAll(async () => {
    const { createExecUpgradeHandler } = await import("../exec-ws");
    // No allowShell passed: the default must be loopback + same-origin only.
    const handle = createExecUpgradeHandler({ path: "/exec-ws", execToken: "embed-token" });
    srv = createServer((_req, res) => res.end());
    srv.on("upgrade", (req, socket, head) => {
      if (!handle(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => srv.listen(PORT_DEFAULT, "127.0.0.1", r));
  });
  afterAll(() => srv?.close());

  function run(headers: Record<string, string>): Promise<string> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT_DEFAULT}/exec-ws`, { headers });
      const done = (v: string) => {
        ws.terminate();
        resolve(v);
      };
      setTimeout(() => done("timeout"), 3000);
      ws.on("error", () => done("refused"));
      ws.on("open", () => ws.send(JSON.stringify({ token: "embed-token" })));
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
  test("loopback same-origin upgrade can exec", async () => {
    expect(await run({ Origin: `http://127.0.0.1:${PORT_DEFAULT}` })).toBe("exit 0");
  });
});
