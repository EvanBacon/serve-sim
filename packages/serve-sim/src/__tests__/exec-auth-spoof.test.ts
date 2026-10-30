import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statSync } from "fs";
import { createServer, type IncomingMessage, type Server } from "http";
import type { AddressInfo, Socket } from "net";
import { simMiddleware } from "../middleware";
import { isTrustedLoopback, registerProxiedPeer } from "../request-trust";
import { execTokenFileForPort, readExecTokenFile, removeExecTokenFile, writeExecTokenFile } from "../state";

// A remote attacker reaches the preview through `ssh -R` / nginx and spoofs
// `Host: localhost` + `Origin: http://localhost`. Neither header may grant
// trust: the exec token must never appear in the page, and /exec must refuse.

delete process.env.SERVE_SIM_AUTH_TOKEN;
(globalThis as Record<string, unknown>).__PREVIEW_HTML_B64__ = Buffer.from(
  "<!doctype html><html><head><!--__SIM_PREVIEW_CONFIG__--></head></html>",
).toString("base64");

const EXEC_TOKEN = "spoof-test-exec-token-5b1d7e";
const DEVICE = "00000000-0000-0000-0000-0000000000BB";
const SPOOFED = { Host: "localhost", Origin: "http://localhost" };
const REMOTE_PEER = "203.0.113.7";

/** Every encoding of the token an attacker could decode out of a page. */
function tokenEncodings(token: string): string[] {
  const buf = Buffer.from(token);
  return [
    token,
    encodeURIComponent(token),
    buf.toString("base64"),
    buf.toString("base64url"),
    buf.toString("hex"),
    JSON.stringify(token).slice(1, -1),
  ];
}

interface Listening { server: Server; origin: string }

/**
 * Serve the real middleware on 127.0.0.1. With `remotePeer`, each connection
 * is recorded as coming from that address — what the Bun front server does
 * for a non-loopback TCP peer (see registerProxiedPeer).
 */
function listen(allowExec: boolean, remotePeer?: string): Promise<Listening> {
  const middleware = simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, device: DEVICE, allowExec });
  const server = createServer((req, res) => {
    middleware(req, res, async () => {
      if (!res.headersSent) res.statusCode = 404;
      res.end("Not found");
    });
  });
  if (remotePeer) {
    server.on("connection", (socket: Socket) => {
      const unregister = registerProxiedPeer(socket.remotePort!, remotePeer);
      socket.on("close", unregister);
    });
  }
  server.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket as Socket, head));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

function getPage(origin: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${origin}/`, { headers: { ...SPOOFED, ...headers } });
}

function postExec(origin: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${origin}/exec`, {
    method: "POST",
    headers: {
      ...SPOOFED,
      "Content-Type": "application/json",
      Authorization: `Bearer ${EXEC_TOKEN}`,
      ...headers,
    },
    body: JSON.stringify({ command: "echo should-not-run" }),
  });
}

const FORWARDED_HEADER_SETS: Record<string, Record<string, string>> = {
  "X-Forwarded-For": { "X-Forwarded-For": REMOTE_PEER },
  "X-Forwarded-Host": { "X-Forwarded-Host": "localhost" },
  "X-Real-IP": { "X-Real-IP": REMOTE_PEER },
  Forwarded: { Forwarded: `for=${REMOTE_PEER};host=localhost` },
};

let execOnLoopback: Listening;
let execOnRemotePeer: Listening;
let execOff: Listening;

beforeAll(async () => {
  execOnLoopback = await listen(true);
  execOnRemotePeer = await listen(true, REMOTE_PEER);
  execOff = await listen(false);
});

afterAll(() => {
  execOnLoopback.server.close();
  execOnRemotePeer.server.close();
  execOff.server.close();
});

describe("isTrustedLoopback ignores spoofed Host/Origin", () => {
  function fakeReq(remoteAddress: string, headers: Record<string, string>): Pick<IncomingMessage, "socket" | "headers"> {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { socket: { remoteAddress } as IncomingMessage["socket"], headers: lower };
  }

  test("non-loopback socket with Host: localhost and Origin: http://localhost is untrusted", () => {
    expect(isTrustedLoopback(fakeReq(REMOTE_PEER, SPOOFED))).toBe(false);
    expect(isTrustedLoopback(fakeReq("::ffff:203.0.113.7", SPOOFED))).toBe(false);
    expect(isTrustedLoopback(fakeReq("192.168.1.20", { ...SPOOFED, Host: "127.0.0.1:3100" }))).toBe(false);
  });

  for (const [name, headers] of Object.entries(FORWARDED_HEADER_SETS)) {
    test(`loopback socket carrying ${name} is untrusted`, () => {
      expect(isTrustedLoopback(fakeReq("127.0.0.1", { ...SPOOFED, ...headers }))).toBe(false);
    });
  }

  test("a missing socket address is untrusted even with loopback Host", () => {
    expect(isTrustedLoopback({ socket: {} as IncomingMessage["socket"], headers: { host: "localhost" } })).toBe(false);
  });

  test("a plain loopback socket with no forwarding headers is trusted", () => {
    expect(isTrustedLoopback(fakeReq("127.0.0.1", { Host: "localhost" }))).toBe(true);
    expect(isTrustedLoopback(fakeReq("::1", { Host: "localhost" }))).toBe(true);
  });
});

describe("spoofed Host/Origin cannot obtain the exec token from GET /", () => {
  for (const [name, headers] of Object.entries(FORWARDED_HEADER_SETS)) {
    test(`nginx-style proxy with ${name}: page never contains the token`, async () => {
      const res = await getPage(execOnLoopback.origin, headers);
      const body = await res.text();
      for (const encoded of tokenEncodings(EXEC_TOKEN)) expect(body).not.toContain(encoded);
    });
  }

  test("non-loopback socket peer: page is refused and never contains the token", async () => {
    const res = await getPage(execOnRemotePeer.origin, {});
    expect(res.status).toBe(403);
    const body = await res.text();
    for (const encoded of tokenEncodings(EXEC_TOKEN)) expect(body).not.toContain(encoded);
  });

  test("ssh -R raw forward (loopback socket, no forwarding headers): page never contains the token", async () => {
    const res = await getPage(execOnLoopback.origin, {});
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("window.__SIM_PREVIEW__");
    for (const encoded of tokenEncodings(EXEC_TOKEN)) expect(body).not.toContain(encoded);
    expect(body).not.toContain("execToken");
  });
});

describe("spoofed Host/Origin cannot run /exec", () => {
  for (const [name, headers] of Object.entries(FORWARDED_HEADER_SETS)) {
    test(`nginx-style proxy with ${name} is rejected even with the real token`, async () => {
      const res = await postExec(execOnLoopback.origin, headers);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain("should-not-run");
    });
  }

  test("non-loopback socket peer is rejected even with the real token", async () => {
    const res = await postExec(execOnRemotePeer.origin, {});
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("should-not-run");
  });

  test("ssh -R raw forward without the token is rejected", async () => {
    const res = await postExec(execOnLoopback.origin, { Authorization: "" });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("should-not-run");
  });
});

describe("/exec requires --allow-exec", () => {
  test("POST /exec is rejected without --allow-exec, even from loopback with the real token", async () => {
    const { origin } = execOff;
    const res = await postExec(origin, { Host: new URL(origin).host, Origin: origin });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "exec disabled; start with --allow-exec" });
  });

  test("/exec-ws refuses commands without --allow-exec, even with the real token", async () => {
    const { default: WebSocket } = await import("ws");
    const { origin } = execOff;
    const ws = new WebSocket(`${origin.replace("http", "ws")}/exec-ws`, { headers: { Origin: origin } });
    const reply = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(""), 4000);
      ws.on("open", () => ws.send(JSON.stringify({ token: EXEC_TOKEN })));
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data)) as { ready?: boolean };
        if (msg.ready) {
          ws.send(JSON.stringify({ id: 1, command: "echo should-not-$((1+1))" }));
          return;
        }
        clearTimeout(timer);
        resolve(String(data));
      });
      ws.on("close", () => { clearTimeout(timer); resolve(""); });
      ws.on("error", () => { clearTimeout(timer); resolve(""); });
    });
    ws.terminate();
    expect(reply).not.toContain("should-not-2");
    if (reply) expect(reply).toContain("exec disabled");
  });

  test("with --allow-exec, a genuine loopback client holding the token can exec", async () => {
    const { origin } = execOnLoopback;
    const res = await fetch(`${origin}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${EXEC_TOKEN}`, Origin: origin },
      body: JSON.stringify({ command: "echo ok-$((2+3))" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stdout: string }).stdout.trim()).toBe("ok-5");
  });
});

describe("exec token file", () => {
  const port = 40_000 + (process.pid % 20_000);

  afterAll(() => removeExecTokenFile(port));

  test("token file is written with mode 0600 and read back by the CLI helper", () => {
    const file = writeExecTokenFile(port, EXEC_TOKEN);
    expect(file).toBe(execTokenFileForPort(port));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readExecTokenFile(port)).toBe(EXEC_TOKEN);
  });

  test("rewriting the token file keeps mode 0600", () => {
    writeExecTokenFile(port, `${EXEC_TOKEN}-rotated`);
    expect(statSync(execTokenFileForPort(port)).mode & 0o777).toBe(0o600);
    expect(readExecTokenFile(port)).toBe(`${EXEC_TOKEN}-rotated`);
  });
});
