import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/**
 * Tests for the adaptive frame rate controller in GatewayTransport.
 *
 * We spin up a minimal WebSocket server and simulate frame delivery while
 * manipulating the transport's internal state to test degradation and recovery.
 */

interface ReceivedMessage {
  type: string;
  maxFps?: number;
  [key: string]: any;
}

function startEchoServer(): {
  port: number;
  messages: ReceivedMessage[];
  sendToAll: (data: string) => void;
  close: () => void;
} {
  const messages: ReceivedMessage[] = [];
  const clients = new Set<any>();
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
      },
      close(ws) {
        clients.delete(ws);
      },
      message(ws, message) {
        try {
          const parsed = JSON.parse(
            typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer),
          );
          messages.push(parsed);
        } catch {}
      },
    },
  });
  return {
    port: server.port,
    messages,
    sendToAll: (data: string) => {
      for (const ws of clients) ws.send(data);
    },
    close: () => server.stop(),
  };
}

async function createTransport(port: number) {
  const { GatewayTransport } = await import("../transport");
  const transport = new GatewayTransport({ url: `ws://localhost:${port}` });
  await transport.waitForOpen();
  return transport;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Adaptive FPS", () => {
  let server: ReturnType<typeof startEchoServer>;
  let transport: Awaited<ReturnType<typeof createTransport>>;

  beforeEach(async () => {
    server = startEchoServer();
    transport = await createTransport(server.port);
  });

  afterEach(() => {
    transport.close();
    server.close();
  });

  test("streamSetFps sends stream:set-fps message", async () => {
    transport.streamSetFps(15);
    await sleep(50);
    const setFpsMsgs = server.messages.filter((m) => m.type === "stream:set-fps");
    expect(setFpsMsgs.length).toBe(1);
    expect(setFpsMsgs[0].maxFps).toBe(15);
  });

  test("adaptiveFps starts at 30 after streamStart", () => {
    transport.streamStart();
    expect(transport.adaptiveFps).toBe(30);
    expect(transport.adaptiveState).toBe("normal");
  });

  test("onAdaptiveFps listener is called on FPS changes", async () => {
    const events: Array<{ fps: number; state: string }> = [];
    transport.onAdaptiveFps((fps, state) => {
      events.push({ fps, state });
    });
    transport.streamStart();

    // Simulate high backpressure by overriding bufferedAmount via Object.defineProperty
    // on the internal WebSocket. Since we can't easily control real bufferedAmount,
    // we test the _checkAdaptiveFps logic directly by forcing the state.
    // We do this by sending frames and checking that the controller responds.

    // Access internal ws for testing
    const ws = (transport as any).ws;

    // Mock bufferedAmount to be high
    let mockBuffered = 10000;
    Object.defineProperty(ws, "bufferedAmount", {
      get: () => mockBuffered,
      configurable: true,
    });

    // Send 3 frames to trigger degradation (ADAPTIVE_DEGRADE_COUNT = 3)
    for (let i = 0; i < 3; i++) {
      server.sendToAll(JSON.stringify({ type: "stream:frame", data: "fakebase64" }));
      await sleep(20);
    }

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].fps).toBe(15); // halved from 30
    expect(events[0].state).toBe("degraded");
    expect(transport.adaptiveFps).toBe(15);
    expect(transport.adaptiveState).toBe("degraded");
  });

  test("FPS recovers when bufferedAmount drops", async () => {
    const events: Array<{ fps: number; state: string }> = [];
    transport.onAdaptiveFps((fps, state) => {
      events.push({ fps, state });
    });
    transport.streamStart();

    const ws = (transport as any).ws;

    // First degrade
    let mockBuffered = 10000;
    Object.defineProperty(ws, "bufferedAmount", {
      get: () => mockBuffered,
      configurable: true,
    });

    for (let i = 0; i < 3; i++) {
      server.sendToAll(JSON.stringify({ type: "stream:frame", data: "fakebase64" }));
      await sleep(20);
    }

    expect(transport.adaptiveFps).toBe(15);

    // Now simulate low buffer for recovery (ADAPTIVE_RECOVER_COUNT = 10)
    mockBuffered = 0;

    for (let i = 0; i < 10; i++) {
      server.sendToAll(JSON.stringify({ type: "stream:frame", data: "fakebase64" }));
      await sleep(20);
    }

    expect(transport.adaptiveFps).toBe(20); // 15 + 5 = 20
  });

  test("FPS does not go below minimum (5)", async () => {
    transport.streamStart();

    const ws = (transport as any).ws;
    let mockBuffered = 10000;
    Object.defineProperty(ws, "bufferedAmount", {
      get: () => mockBuffered,
      configurable: true,
    });

    // Keep degrading: 30 -> 15 -> 7 -> 5 (min)
    // Need 3 frames per degradation step
    for (let i = 0; i < 12; i++) {
      server.sendToAll(JSON.stringify({ type: "stream:frame", data: "fakebase64" }));
      await sleep(20);
    }

    expect(transport.adaptiveFps).toBe(5);
  });

  test("FPS does not exceed maximum (30) during recovery", async () => {
    transport.streamStart();

    const ws = (transport as any).ws;

    // Degrade first
    let mockBuffered = 10000;
    Object.defineProperty(ws, "bufferedAmount", {
      get: () => mockBuffered,
      configurable: true,
    });

    for (let i = 0; i < 3; i++) {
      server.sendToAll(JSON.stringify({ type: "stream:frame", data: "fakebase64" }));
      await sleep(20);
    }

    expect(transport.adaptiveFps).toBe(15);

    // Now recover fully: 15 -> 20 -> 25 -> 30
    mockBuffered = 0;

    for (let i = 0; i < 40; i++) {
      server.sendToAll(JSON.stringify({ type: "stream:frame", data: "fakebase64" }));
      await sleep(20);
    }

    expect(transport.adaptiveFps).toBe(30);
    expect(transport.adaptiveState).toBe("normal");
  });

  test("stream:set-fps messages are sent to server on degradation", async () => {
    transport.streamStart();
    await sleep(30);
    server.messages.length = 0; // clear stream:start

    const ws = (transport as any).ws;
    let mockBuffered = 10000;
    Object.defineProperty(ws, "bufferedAmount", {
      get: () => mockBuffered,
      configurable: true,
    });

    for (let i = 0; i < 3; i++) {
      server.sendToAll(JSON.stringify({ type: "stream:frame", data: "fakebase64" }));
      await sleep(20);
    }

    await sleep(50);
    const setFpsMsgs = server.messages.filter((m) => m.type === "stream:set-fps");
    expect(setFpsMsgs.length).toBeGreaterThanOrEqual(1);
    expect(setFpsMsgs[0].maxFps).toBe(15);
  });
});
