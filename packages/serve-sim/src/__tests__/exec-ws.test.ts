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
const TOKEN = "exec-ws-test-token";

let server: PreviewServer;

beforeAll(async () => {
  const middleware = simMiddleware({ basePath: "/", execToken: TOKEN, device: "DEVICE-A" });
  server = await servePreview({ port: PORT, middleware, host: "127.0.0.1" });
});

afterAll(() => {
  server?.stop(true);
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

function connect(token: string): Promise<{
  next: () => Promise<Reply>;
  send: (body: Record<string, unknown>) => void;
  close: () => void;
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/exec-ws`);
    const queue: Reply[] = [];
    const waiters: Array<(r: Reply) => void> = [];
    let closeResolve: () => void;
    const closed = new Promise<void>((r) => {
      closeResolve = r;
    });
    const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ token }));
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
  test("authenticates and runs a shell exec", async () => {
    const channel = await connect(TOKEN);
    expect((await channel.next()).ready).toBe(true);
    channel.send({ id: 1, command: "echo channel-works" });
    const reply = await channel.next();
    expect(reply.id).toBe(1);
    expect(reply.exitCode).toBe(0);
    expect(reply.stdout?.trim()).toBe("channel-works");
    channel.close();
  });

  test("rejects a bad token by closing the socket", async () => {
    const channel = await connect("wrong-token");
    await channel.closed;
  });

  test("ui requests validate their payload", async () => {
    const channel = await connect(TOKEN);
    await channel.next(); // ready
    channel.send({ id: 2, ui: { device: "not a udid!!", option: "appearance" } });
    const reply = await channel.next();
    expect(reply.id).toBe(2);
    expect(reply.error).toMatch(/invalid device/i);
    channel.close();
  });

  test("sse subscriptions reject paths outside the allowlist", async () => {
    const channel = await connect(TOKEN);
    await channel.next(); // ready
    channel.send({ sub: 7, path: "/exec" });
    const reply = await channel.next();
    expect(reply.sub).toBe(7);
    expect(reply.end).toBe(true);
    expect(reply.error).toMatch(/not allowed/i);
    channel.close();
  });

  test("sse subscription streams a real middleware route", async () => {
    const channel = await connect(TOKEN);
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

    const channel = await connect(TOKEN);
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
