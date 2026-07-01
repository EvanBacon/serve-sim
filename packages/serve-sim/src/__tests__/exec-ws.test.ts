import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";
import type { Duplex } from "stream";
import { WebSocket as WsClient } from "ws";
import { createExecUpgradeHandler } from "../exec-ws";
import {
  previewConfigForState,
  rewriteStateForRequestHost,
  simMiddleware,
  type ServeSimState,
} from "../middleware";
import { servePreview, type PreviewServer } from "../runtime";

// The control channel is the ONLY transport the preview page uses for execs,
// simulator settings, and SSE side-channels — there is deliberately no HTTP
// fallback, so a broken upgrade path bricks the UI. This suite runs under
// `bun test` (the CI flow), which is exactly the runtime where hand-rolled
// RFC6455 framing silently failed before: node:http under Bun emits
// `upgrade` but never flushes raw handshake bytes, which is why the channel
// is built on `ws` (Bun substitutes its native implementation).

const PORT = 3461;
const HOST_FORWARD_PORT = 3462;
const TOKEN = "exec-ws-test-token";
const PREVIEW_STATE: ServeSimState = {
  pid: process.pid,
  port: 3100,
  device: "DEVICE-A",
  url: "http://127.0.0.1:3100",
  streamUrl: "http://127.0.0.1:3100/stream.mjpeg",
  wsUrl: "ws://127.0.0.1:3100/ws",
};

let server: PreviewServer;

beforeAll(async () => {
  const middleware = simMiddleware({ basePath: "/", execToken: TOKEN });
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

function connectWithHeaders(
  url: string,
  token: string,
  headers: Record<string, string>,
): Promise<{
  next: () => Promise<Reply>;
  send: (body: Record<string, unknown>) => void;
  close: () => void;
  closed: Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WsClient(url, { headers });
    const queue: Reply[] = [];
    const waiters: Array<(r: Reply) => void> = [];
    let closeResolve: () => void;
    const closed = new Promise<void>((r) => {
      closeResolve = r;
    });
    const timer = setTimeout(() => reject(new Error("connect timeout")), 5000);

    ws.on("open", () => {
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
    });
    ws.on("message", (data) => {
      const reply = JSON.parse(data.toString()) as Reply;
      const waiter = waiters.shift();
      if (waiter) waiter(reply);
      else queue.push(reply);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on("close", () => closeResolve());
  });
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

  test("sse loopback requests preserve the upgrade host for preview config rewriting", async () => {
    const middleware = Object.assign(
      (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.url?.split("?")[0] === "/api/events") {
          const remoteState = rewriteStateForRequestHost(PREVIEW_STATE, req.headers.host);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          res.end(
            `data: ${JSON.stringify(
              previewConfigForState(remoteState, "/", "/bin/serve-sim", TOKEN),
            )}\n\n`,
          );
          return;
        }
        next();
      },
      {
        handleUpgrade: createExecUpgradeHandler({
          path: "/exec-ws",
          execToken: TOKEN,
          ssePrefixes: ["/api/events"],
        }) as (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean,
      },
    );

    const hostForwardServer = await servePreview({
      port: HOST_FORWARD_PORT,
      middleware,
      host: "127.0.0.1",
    });

    try {
      const lanHost = `minipro24.lan:${HOST_FORWARD_PORT}`;
      const lanChannel = await connectWithHeaders(
        `ws://127.0.0.1:${HOST_FORWARD_PORT}/exec-ws`,
        TOKEN,
        {
          Host: lanHost,
          Origin: `http://${lanHost}`,
        },
      );
      await lanChannel.next(); // ready
      lanChannel.send({ sub: 9, path: "/api/events" });
      const lanReply = await lanChannel.next();
      const lanConfig = JSON.parse(lanReply.data!.replace(/^data: /, "").trim());
      expect(lanConfig.streamUrl).toBe("http://minipro24.lan:3100/stream.mjpeg");
      expect(lanConfig.wsUrl).toBe("ws://minipro24.lan:3100/ws");
      lanChannel.close();

      const commaHostChannel = await connectWithHeaders(
        `ws://127.0.0.1:${HOST_FORWARD_PORT}/exec-ws`,
        TOKEN,
        {
          Host: `${lanHost}, 127.0.0.1:${HOST_FORWARD_PORT}`,
        },
      );
      await commaHostChannel.next(); // ready
      commaHostChannel.send({ sub: 10, path: "/api/events" });
      const commaHostReply = await commaHostChannel.next();
      const commaHostConfig = JSON.parse(commaHostReply.data!.replace(/^data: /, "").trim());
      expect(commaHostConfig.streamUrl).toBe("http://minipro24.lan:3100/stream.mjpeg");
      expect(commaHostConfig.wsUrl).toBe("ws://minipro24.lan:3100/ws");
      commaHostChannel.close();

      const loopbackHost = `127.0.0.1:${HOST_FORWARD_PORT}`;
      const loopbackChannel = await connectWithHeaders(
        `ws://127.0.0.1:${HOST_FORWARD_PORT}/exec-ws`,
        TOKEN,
        {
          Host: loopbackHost,
          Origin: `http://${loopbackHost}`,
        },
      );
      await loopbackChannel.next(); // ready
      loopbackChannel.send({ sub: 11, path: "/api/events" });
      const loopbackReply = await loopbackChannel.next();
      const loopbackConfig = JSON.parse(loopbackReply.data!.replace(/^data: /, "").trim());
      expect(loopbackConfig.streamUrl).toBe("http://127.0.0.1:3100/stream.mjpeg");
      expect(loopbackConfig.wsUrl).toBe("ws://127.0.0.1:3100/ws");
      loopbackChannel.close();
    } finally {
      hostForwardServer.stop(true);
    }
  });
});
