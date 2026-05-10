import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectionQuality } from "../transport";

/**
 * Tests for connection quality monitoring in GatewayTransport.
 *
 * We spin up a minimal WebSocket server that sends simulated stream:frame
 * messages at controlled intervals, then verify the transport correctly
 * classifies connection quality based on frame inter-arrival time.
 */

function startFrameServer(): {
  port: number;
  sendFrame: () => void;
  close: () => void;
  clients: Set<any>;
} {
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
      message() {},
    },
  });

  const sendFrame = () => {
    const msg = JSON.stringify({ type: "stream:frame", data: "AAAA" });
    for (const ws of clients) {
      ws.send(msg);
    }
  };

  return { port: server.port!, sendFrame, close: () => server.stop(), clients };
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

describe("Connection quality", () => {
  let server: ReturnType<typeof startFrameServer>;
  let transport: Awaited<ReturnType<typeof createTransport>>;

  beforeEach(async () => {
    server = startFrameServer();
    transport = await createTransport(server.port);
  });

  afterEach(() => {
    transport.close();
    server.close();
  });

  test("quality starts as null before any frames", () => {
    expect(transport.getConnectionQuality()).toBeNull();
  });

  test("quality is good with fast frames", async () => {
    const qualities: ConnectionQuality[] = [];
    transport.onConnectionQualityChange((q) => qualities.push(q));

    // Send 12 frames rapidly (~30ms apart, well within 100ms threshold)
    for (let i = 0; i < 12; i++) {
      server.sendFrame();
      await sleep(30);
    }

    expect(transport.getConnectionQuality()).toBe("good");
    // Should have received at least one quality change callback
    expect(qualities.length).toBeGreaterThan(0);
    expect(qualities[qualities.length - 1]).toBe("good");
  });

  test("quality degrades with slow frames", async () => {
    const qualities: ConnectionQuality[] = [];
    transport.onConnectionQualityChange((q) => qualities.push(q));

    // Send frames at ~150ms intervals (between 100-250ms = degraded)
    for (let i = 0; i < 12; i++) {
      server.sendFrame();
      await sleep(150);
    }

    expect(transport.getConnectionQuality()).toBe("degraded");
    expect(qualities).toContain("degraded");
  });

  test("quality is poor with very slow frames", async () => {
    const qualities: ConnectionQuality[] = [];
    transport.onConnectionQualityChange((q) => qualities.push(q));

    // Send frames at ~300ms intervals (>250ms = poor)
    for (let i = 0; i < 12; i++) {
      server.sendFrame();
      await sleep(300);
    }

    expect(transport.getConnectionQuality()).toBe("poor");
    expect(qualities).toContain("poor");
  });

  test("quality transitions from good to poor as frames slow down", async () => {
    const qualities: ConnectionQuality[] = [];
    transport.onConnectionQualityChange((q) => qualities.push(q));

    // Start fast
    for (let i = 0; i < 12; i++) {
      server.sendFrame();
      await sleep(30);
    }

    expect(transport.getConnectionQuality()).toBe("good");

    // Slow down significantly
    for (let i = 0; i < 12; i++) {
      server.sendFrame();
      await sleep(300);
    }

    expect(transport.getConnectionQuality()).toBe("poor");
    // Should have seen both good and poor
    expect(qualities).toContain("good");
    expect(qualities).toContain("poor");
  });

  test("unsubscribe stops callbacks", async () => {
    const qualities: ConnectionQuality[] = [];
    const unsub = transport.onConnectionQualityChange((q) => qualities.push(q));

    server.sendFrame();
    await sleep(30);
    server.sendFrame();
    await sleep(30);

    unsub();

    // Send more frames after unsubscribe
    for (let i = 0; i < 10; i++) {
      server.sendFrame();
      await sleep(300);
    }

    // Should not have received poor quality callback after unsub
    const poorAfterUnsub = qualities.filter((q) => q === "poor");
    expect(poorAfterUnsub.length).toBe(0);
  });
});
