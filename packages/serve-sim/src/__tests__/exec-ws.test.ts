import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { createServer, type Server } from "http";
import type { AddressInfo, Socket } from "net";
import { clearEventLogForTests, recordEventLogEvent } from "../event-log";
import { createExecUpgradeHandler } from "../exec-ws";
import { simMiddleware, type ServeSimState } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";
import { STATE_DIR, stateFileForDevice } from "../state";

// The control channel is the ONLY transport the preview page uses for execs,
// simulator settings, and SSE side-channels — there is deliberately no HTTP
// fallback, so a broken upgrade path bricks the UI. This suite runs under
// `bun test` (the CI flow), which is exactly the runtime where hand-rolled
// RFC6455 framing silently failed before: node:http under Bun emits
// `upgrade` but never flushes raw handshake bytes, which is why the channel
// is built on `ws` (Bun substitutes its native implementation).

const PORT = 3461;
const PORT_NO_EXEC = 3462;
const EXEC_TOKEN = "exec-ws-test-token";

let server: PreviewServer;
let noExecServer: PreviewServer;

beforeAll(async () => {
  const middleware = simMiddleware({ basePath: "/", allowExec: true, execToken: EXEC_TOKEN, device: "DEVICE-A" });
  server = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
  noExecServer = await servePreview({
    port: PORT_NO_EXEC,
    middleware: simMiddleware({ basePath: "/", execToken: EXEC_TOKEN, device: "DEVICE-A" }),
    host: "127.0.0.1",
  });
});

afterAll(() => {
  server?.stop(true);
  noExecServer?.stop(true);
});

interface Reply {
  ready?: boolean;
  id?: number;
  stdout?: string;
  exitCode?: number;
  error?: string;
  sub?: number;
  end?: boolean;
  data?: string;
}

function connect(
  port = PORT,
  first: Record<string, unknown> = {},
  host = `127.0.0.1:${port}`,
  extraHeaders: Record<string, string> = {},
): Promise<{
  next: () => Promise<Reply>;
  send: (body: Record<string, unknown>) => void;
  close: () => void;
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    // Browsers always send Origin on WebSocket upgrades, and the control
    // channel requires it (loopback same-origin for shell access).
    const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, {
      headers: { Host: host, Origin: `http://${host}`, ...extraHeaders },
    } as never);
    const queue: Reply[] = [];
    const waiters: Array<(r: Reply) => void> = [];
    let closeResolve: () => void;
    const closed = new Promise<void>((r) => {
      closeResolve = r;
    });
    const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      // The page holds no exec token, so its first frame is `{}`; only a
      // local process that read the token file sends `{token}`.
      ws.send(JSON.stringify(first));
      resolve({
        next: () =>
          new Promise<Reply>((r, rej) => {
            const queued = queue.shift();
            if (queued) return r(queued);
            const bail = setTimeout(() => rej(new Error("reply timeout")), 5000);
            waiters.push((reply) => {
              clearTimeout(bail);
              r(reply);
            });
          }),
        send: (body) => ws.send(JSON.stringify(body)),
        close: () => ws.close(),
        closed,
      });
    };
    ws.onmessage = (event) => {
      const reply = JSON.parse(String(event.data)) as Reply;
      const waiter = waiters.shift();
      if (waiter) waiter(reply);
      else queue.push(reply);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("socket error"));
    };
    ws.onclose = () => closeResolve();
  });
}

/** Reads a subscription's chunks until the first complete SSE `data:` frame. */
async function readFirstSseData(channel: { next: () => Promise<Reply> }): Promise<string> {
  let buffered = "";
  for (;;) {
    const reply = await channel.next();
    buffered += reply.data ?? "";
    const frame = /^data: (.*)\n\n/m.exec(buffered);
    if (frame) return frame[1]!;
    if (reply.end) throw new Error(`stream ended before a data frame: ${reply.error ?? buffered}`);
  }
}

describe("exec-ws control channel", () => {
  test("runs a shell exec for a loopback socket holding the exec token (allowExec)", async () => {
    const channel = await connect(PORT, { token: EXEC_TOKEN });
    expect((await channel.next()).ready).toBe(true);
    channel.send({ id: 1, command: "echo channel-works" });
    const reply = await channel.next();
    expect(reply.id).toBe(1);
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout?.trim()).toBe("channel-works");
    channel.close();
  });

  test("refuses shell execs from the token-less page, even with allowExec", async () => {
    for (const first of [{}, { token: "wrong" }]) {
      const channel = await connect(PORT, first);
      expect((await channel.next()).ready).toBe(true);
      channel.send({ id: 1, command: "echo should-not-run" });
      const reply = await channel.next();
      expect(reply.id).toBe(1);
      expect(reply.exitCode).toBe(126);
      expect(reply.error).toBe("exec requires the exec token");
      expect(reply.stdout).not.toContain("should-not-run");
      channel.close();
    }
  });

  test("refuses shell execs unless the server opted in with allowExec", async () => {
    const channel = await connect(PORT_NO_EXEC, { token: EXEC_TOKEN });
    expect((await channel.next()).ready).toBe(true);
    channel.send({ id: 1, command: "echo should-not-run" });
    const reply = await channel.next();
    expect(reply.id).toBe(1);
    expect(reply.exitCode).toBe(126);
    expect(reply.error).toBe("exec disabled; start with --allow-exec");
    expect(reply.stdout).not.toContain("should-not-run");
    channel.close();
  });

  test("host actions reject unknown methods and invalid params", async () => {
    const channel = await connect(PORT_NO_EXEC);
    await channel.next(); // ready
    channel.send({ id: 3, rpc: { method: "exec", params: { command: "echo nope" } } });
    expect((await channel.next()).error).toMatch(/unknown method/);
    channel.send({ id: 4, rpc: { method: "home", params: { udid: "booted; echo nope" } } });
    expect((await channel.next()).error).toBe("invalid udid");
    channel.close();
  });

  test("ui requests validate their payload", async () => {
    const channel = await connect();
    await channel.next(); // ready
    channel.send({ id: 2, ui: { device: "not a udid!!", option: "appearance" } });
    const reply = await channel.next();
    expect(reply.id).toBe(2);
    expect(reply.error).toMatch(/invalid device/i);
    channel.close();
  });

  test("sse subscriptions reject paths outside the allowlist", async () => {
    const channel = await connect();
    await channel.next(); // ready
    channel.send({ sub: 7, path: "/exec" });
    const reply = await channel.next();
    expect(reply.sub).toBe(7);
    expect(reply.end).toBe(true);
    expect(reply.error).toMatch(/not allowed/i);
    channel.close();
  });

  test("sse subscriptions reject control characters and non-latin1 paths", async () => {
    const channel = await connect();
    await channel.next(); // ready
    const guarded = [
      "/api/events?device=a\r\nX-Injected: 1",
      "/api/events?device=\u0000",
      "/api/events?device=\u007f",
      "/api/events?device=a b",
      "/api/events\r\nX-Injected: 1",
      "api/events",
    ];
    let sub = 20;
    for (const path of guarded) {
      channel.send({ sub, path });
      const reply = await channel.next();
      expect({ path, sub: reply.sub, end: reply.end, error: reply.error }).toEqual({
        path,
        sub,
        end: true,
        error: "path not allowed",
      });
      sub++;
    }
    channel.send({ sub, path: "/api/events?device=\u0100" });
    const reply = await channel.next();
    expect(reply.sub).toBe(sub);
    expect(reply.end).toBe(true);
    expect(reply.error).toBe("bad path");
    channel.close();
  });

  test("sse subscription streams a real middleware route", async () => {
    const channel = await connect();
    await channel.next(); // ready
    channel.send({ sub: 8, path: "/api/events" });
    // /api/events sends an initial SSE payload immediately on connect.
    const reply = await channel.next();
    expect(reply.sub).toBe(8);
    expect(typeof (reply as { data?: string }).data).toBe("string");
    channel.send({ unsub: 8 });
    channel.close();
  });

  test("event log endpoint filters by device", async () => {
    clearEventLogForTests();
    recordEventLogEvent({
      device: "DEVICE-A",
      source: "hid",
      kind: "button",
      summary: "Button home",
    });
    recordEventLogEvent({
      device: "DEVICE-B",
      source: "hid",
      kind: "button",
      summary: "Button volume-up",
    });

    const res = await fetch(`http://127.0.0.1:${PORT}/api/event-log?device=DEVICE-B`);
    expect(res.status).toBe(200);
    const payload = await res.json() as { events: Array<{ msg: string; summary: string }> };
    expect(payload.events.map((event) => event.msg)).toEqual(["Button volume-up"]);
    expect(payload.events.map((event) => event.summary)).toEqual(["Button volume-up"]);
  });

  test("event log endpoint only filters when a device query is present", async () => {
    clearEventLogForTests();
    recordEventLogEvent({
      device: "DEVICE-A",
      source: "hid",
      kind: "button",
      summary: "Button home",
    });
    recordEventLogEvent({
      device: "DEVICE-B",
      source: "hid",
      kind: "button",
      summary: "Button volume-up",
    });

    const res = await fetch(`http://127.0.0.1:${PORT}/api/event-log`);
    expect(res.status).toBe(200);
    const payload = await res.json() as { events: Array<{ summary: string }> };
    expect(payload.events.map((event) => event.summary)).toEqual([
      "Button home",
      "Button volume-up",
    ]);
  });

  test("event log sse route is available over the control socket", async () => {
    clearEventLogForTests();
    recordEventLogEvent({
      device: "DEVICE-A",
      source: "hid",
      kind: "button",
      summary: "Button home",
    });

    const channel = await connect();
    await channel.next(); // ready
    channel.send({ sub: 9, path: "/api/event-log/events?device=DEVICE-A" });
    let reply = await channel.next();
    let data = /^data: (.*)$/m.exec(reply.data ?? "")?.[1];
    for (let attempts = 0; !data && attempts < 5; attempts++) {
      reply = await channel.next();
      data = /^data: (.*)$/m.exec(reply.data ?? "")?.[1];
    }
    expect(reply.sub).toBe(9);
    expect(data).toBeTruthy();
    const payload = JSON.parse(data!) as { events?: Array<{ summary: string }> };
    expect(payload.events?.map((event) => event.summary)).toEqual(["Button home"]);
    channel.send({ unsub: 9 });
    channel.close();
  });

  test("sse loopback uses the server's bound port, never the Host header", async () => {
    // A decoy listener on the port a hostile Host header names.
    let decoyHits = 0;
    const decoy = createServer((_req, res) => {
      decoyHits++;
      res.end();
    });
    await new Promise<void>((r) => decoy.listen(0, "127.0.0.1", r));
    const decoyPort = (decoy.address() as AddressInfo).port;
    const listen = (middleware: ReturnType<typeof simMiddleware>) =>
      new Promise<Server>((resolve) => {
        const server = createServer((req, res) => void middleware(req, res));
        // Simulate a runtime whose upgrade socket has no local port.
        server.on("upgrade", (req, socket, head) => {
          Object.defineProperty(socket, "localPort", { get: () => undefined });
          middleware.handleUpgrade(req, socket as Socket, head);
        });
        server.listen(0, "127.0.0.1", () => resolve(server));
      });
    const portOf = (server: Server) => (server.address() as AddressInfo).port;
    const withPort = simMiddleware({ basePath: "/", device: "DEVICE-A" });
    const withoutPort = simMiddleware({ basePath: "/", device: "DEVICE-A" });
    const known = await listen(withPort);
    const unknown = await listen(withoutPort);
    withPort.setServerPort(portOf(known));
    try {
      const channel = await connect(portOf(known), {}, `127.0.0.1:${decoyPort}`);
      await channel.next(); // ready
      channel.send({ sub: 10, path: "/api/events" });
      const reply = await channel.next();
      expect(reply.sub).toBe(10);
      expect(typeof reply.data).toBe("string");
      channel.close();

      const blind = await connect(portOf(unknown), {}, `127.0.0.1:${decoyPort}`);
      await blind.next(); // ready
      blind.send({ sub: 11, path: "/api/events" });
      expect(await blind.next()).toEqual({ sub: 11, end: true, error: "no local port" });
      blind.close();
      expect(decoyHits).toBe(0);
    } finally {
      for (const server of [decoy, known, unknown]) {
        server.closeAllConnections();
        server.close();
      }
    }
  });
  test("sse loopback forwards the viewer's Host so LAN viewers get LAN helper URLs (#92)", async () => {
    // /api/events builds helper URLs from the request's Host
    // (rewriteStateForRequestHost): a loopback Host keeps 127.0.0.1, any other
    // Host swaps it in. The loopback SSE request must carry the viewer's Host,
    // or a LAN viewer is handed 127.0.0.1 stream/ws URLs it cannot reach.
    const seenHosts: Array<string | undefined> = [];
    const handler = createExecUpgradeHandler({
      path: "/exec-ws",
      ssePrefixes: ["/host-echo"],
      serverPort: () => (echo.address() as AddressInfo).port,
    });
    const echo = createServer((req, res) => {
      seenHosts.push(req.headers.host);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${req.headers.host ?? ""}\n\n`);
    });
    echo.on("upgrade", (req, socket, head) => {
      if (!handler(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const port = (echo.address() as AddressInfo).port;
    const hostEcho = async (host: string, sub: number) => {
      const channel = await connect(port, {}, host);
      await channel.next(); // ready
      channel.send({ sub, path: "/host-echo" });
      let data = "";
      for (let reply = await channel.next(); !reply.end; reply = await channel.next()) {
        data += reply.data ?? "";
      }
      channel.close();
      return /^data: (.*)$/m.exec(data)?.[1];
    };
    try {
      expect(await hostEcho(`192.168.1.50:${port}`, 1)).toBe(`192.168.1.50:${port}`);
      expect(await hostEcho(`127.0.0.1:${port}`, 2)).toBe(`127.0.0.1:${port}`);
      expect(await hostEcho(`localhost:${port}`, 3)).toBe(`localhost:${port}`);
      expect(seenHosts).toEqual([`192.168.1.50:${port}`, `127.0.0.1:${port}`, `localhost:${port}`]);
    } finally {
      echo.closeAllConnections();
      echo.close();
    }
  });

  test("an authenticated LAN or tunnel viewer's /api/events config uses its own host and scheme, without local-only fields (#92)", async () => {
    // A non-loopback Host makes the loopback SSE request "remote" to the auth
    // gate, so it must present the same credentials the upgrade did — and the
    // config it streams must match what a direct GET from that viewer gets:
    // helper URLs on the viewer's host/scheme, no local CLI path, no allowExec.
    const authToken = "exec-ws-lan-token";
    const device = `EXEC-WS-LAN-${process.pid}`;
    const stateFile = stateFileForDevice(device);
    mkdirSync(STATE_DIR, { recursive: true });
    const state: ServeSimState = {
      pid: process.pid,
      port: 3100,
      device,
      url: "http://127.0.0.1:3100",
      streamUrl: `http://127.0.0.1:3100/helper/${device}/stream.mjpeg`,
      wsUrl: `ws://127.0.0.1:3100/helper/${device}/ws`,
    };
    writeFileSync(stateFile, JSON.stringify(state));
    const middleware = simMiddleware({
      basePath: "/",
      authToken,
      device,
      allowExec: true,
      serveSimBin: "/local/only/serve-sim",
    });
    const lan = createServer((req, res) => void middleware(req, res));
    lan.on("upgrade", (req, socket, head) => middleware.handleUpgrade(req, socket as Socket, head));
    await new Promise<void>((r) => lan.listen(0, "127.0.0.1", r));
    const port = (lan.address() as AddressInfo).port;
    middleware.setServerPort(port);
    const eventsConfig = async (host: string, headers: Record<string, string>) => {
      const channel = await connect(port, {}, host, headers);
      try {
        expect((await channel.next()).ready).toBe(true);
        channel.send({ sub: 12, path: "/api/events" });
        return JSON.parse(await readFirstSseData(channel)) as Record<string, unknown>;
      } finally {
        channel.close();
      }
    };
    const bearer = { Authorization: `Bearer ${authToken}` };
    const devicePath = `/helper/${device}`;
    try {
      const lanHost = `192.168.1.50:${port}`;
      const lanConfig = await eventsConfig(lanHost, bearer);
      expect(lanConfig.streamUrl).toBe(`http://${lanHost}${devicePath}/stream.mjpeg`);
      expect(lanConfig.wsUrl).toBe(`ws://${lanHost}${devicePath}/ws`);
      expect(lanConfig.serveSimBin).toBe("");
      expect(lanConfig.allowExec).toBeUndefined();

      // HTTPS tunnel (ngrok / cloudflared / Tailscale Serve) preserving Host:
      // the replayed x-forwarded-proto keeps the helper URLs https/wss so the
      // https page doesn't block them as mixed content.
      const tunnelHost = "sim.example.ts.net";
      const tunnelConfig = await eventsConfig(tunnelHost, { ...bearer, "X-Forwarded-Proto": "https" });
      expect(tunnelConfig.streamUrl).toBe(`https://${tunnelHost}${devicePath}/stream.mjpeg`);
      expect(tunnelConfig.wsUrl).toBe(`wss://${tunnelHost}${devicePath}/ws`);
      expect(tunnelConfig.serveSimBin).toBe("");
      expect(tunnelConfig.allowExec).toBeUndefined();

      // The trusted local viewer is unchanged: loopback URLs and local fields.
      const localConfig = await eventsConfig(`127.0.0.1:${port}`, {});
      expect(localConfig.streamUrl).toBe(`http://127.0.0.1:${port}${devicePath}/stream.mjpeg`);
      expect(localConfig.serveSimBin).toBe("/local/only/serve-sim");
      expect(localConfig.allowExec).toBe(true);
    } finally {
      rmSync(stateFile, { force: true });
      lan.closeAllConnections();
      lan.close();
    }
  });
});
