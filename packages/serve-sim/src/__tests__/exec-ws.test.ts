import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clearEventLogForTests, recordEventLogEvent } from "../event-log";
import { simMiddleware } from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

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

function connect(port = PORT, first: Record<string, unknown> = {}): Promise<{
  next: () => Promise<Reply>;
  send: (body: Record<string, unknown>) => void;
  close: () => void;
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    // Browsers always send Origin on WebSocket upgrades, and the control
    // channel requires it (loopback same-origin for shell access).
    const ws = new WebSocket(`ws://127.0.0.1:${port}/exec-ws`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
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
});
