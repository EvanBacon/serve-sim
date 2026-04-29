import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { decodeTouchMessage, isBinaryTouchMessage } from "../touch-codec";

/**
 * Tests for touch throttle + backpressure in GatewayTransport.
 *
 * We spin up a minimal WebSocket server that records every message it receives,
 * then drive the transport's streamTouch/streamMultiTouch methods and assert
 * on what actually crossed the wire.
 *
 * Touch messages arrive as binary (compact codec), non-touch as JSON.
 */

interface ReceivedMessage {
  type: string;
  data?: any;
  seq?: number;
}

function startEchoServer(): {
  port: number;
  messages: ReceivedMessage[];
  close: () => void;
} {
  const messages: ReceivedMessage[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined;
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      message(ws, message) {
        // Handle binary touch messages
        if (typeof message !== "string") {
          const buf = message instanceof ArrayBuffer ? message : (message as Buffer).buffer.slice(
            (message as Buffer).byteOffset,
            (message as Buffer).byteOffset + (message as Buffer).byteLength,
          );
          if (isBinaryTouchMessage(buf)) {
            const decoded = decodeTouchMessage(buf);
            if (decoded) {
              messages.push({
                type: decoded.kind === "touch" ? "stream:touch" : "stream:multitouch",
                data: decoded.data,
                seq: decoded.seq,
              });
              return;
            }
          }
        }
        // Handle JSON messages (buttons, etc.)
        try {
          const parsed = JSON.parse(
            typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer),
          );
          messages.push(parsed);
        } catch {}
      },
    },
  });
  return { port: server.port, messages, close: () => server.stop() };
}

// Dynamically import so the test module resolves correctly
async function createTransport(port: number) {
  const { GatewayTransport } = await import("../transport");
  const transport = new GatewayTransport({ url: `ws://localhost:${port}` });
  await transport.waitForOpen();
  return transport;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Touch throttle", () => {
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

  test("begin and end are never dropped", async () => {
    transport.streamTouch({ type: "begin", x: 0.1, y: 0.2 });
    transport.streamTouch({ type: "end", x: 0.1, y: 0.2 });

    await sleep(50);

    const types = server.messages.map((m) => m.data?.type);
    expect(types).toContain("begin");
    expect(types).toContain("end");
  });

  test("rapid moves are throttled (fewer sent than generated)", async () => {
    transport.streamTouch({ type: "begin", x: 0, y: 0 });

    // Send 60 moves as fast as possible (~1ms each)
    for (let i = 0; i < 60; i++) {
      transport.streamTouch({ type: "move", x: i / 60, y: i / 60 });
    }

    transport.streamTouch({ type: "end", x: 1, y: 1 });

    // Wait for any pending throttled sends to flush
    await sleep(100);

    const moves = server.messages.filter((m) => m.data?.type === "move");
    const begins = server.messages.filter((m) => m.data?.type === "begin");
    const ends = server.messages.filter((m) => m.data?.type === "end");

    // begin and end must be present
    expect(begins.length).toBe(1);
    expect(ends.length).toBe(1);

    // Moves should be significantly fewer than 60
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.length).toBeLessThan(30);
  });

  test("end flushes the last pending move position", async () => {
    transport.streamTouch({ type: "begin", x: 0, y: 0 });

    // Send two rapid moves — the second replaces the first in the buffer
    transport.streamTouch({ type: "move", x: 0.3, y: 0.3 });
    transport.streamTouch({ type: "move", x: 0.7, y: 0.7 });

    // Immediately end — this should flush the buffered move
    transport.streamTouch({ type: "end", x: 0.9, y: 0.9 });

    await sleep(100);

    // Find the last move before end
    const touchMsgs = server.messages.filter((m) => m.type === "stream:touch");
    const endIdx = touchMsgs.findIndex((m) => m.data?.type === "end");
    expect(endIdx).toBeGreaterThan(0);

    // The move just before end should have the latest buffered position (~0.7, ~0.7)
    // (float32 encoding may introduce minor rounding)
    const moveBeforeEnd = touchMsgs[endIdx - 1];
    expect(moveBeforeEnd?.data?.type).toBe("move");
    expect(moveBeforeEnd?.data?.x).toBeCloseTo(0.7, 4);
    expect(moveBeforeEnd?.data?.y).toBeCloseTo(0.7, 4);
  });

  test("sequence numbers are monotonically increasing", async () => {
    transport.streamTouch({ type: "begin", x: 0, y: 0 });
    // Space out moves so they actually send
    for (let i = 0; i < 5; i++) {
      transport.streamTouch({ type: "move", x: i / 5, y: i / 5 });
      await sleep(35); // > throttle interval
    }
    transport.streamTouch({ type: "end", x: 1, y: 1 });

    await sleep(50);

    const seqs = server.messages
      .filter((m) => m.type === "stream:touch" && typeof m.seq === "number")
      .map((m) => m.seq!);

    expect(seqs.length).toBeGreaterThan(2);

    // Each seq should be > the previous
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  test("new begin resets throttle state", async () => {
    // First gesture
    transport.streamTouch({ type: "begin", x: 0, y: 0 });
    transport.streamTouch({ type: "move", x: 0.5, y: 0.5 });
    transport.streamTouch({ type: "end", x: 0.5, y: 0.5 });

    await sleep(50);

    // Second gesture immediately
    transport.streamTouch({ type: "begin", x: 0.1, y: 0.1 });
    transport.streamTouch({ type: "move", x: 0.2, y: 0.2 });
    transport.streamTouch({ type: "end", x: 0.2, y: 0.2 });

    await sleep(100);

    const begins = server.messages.filter((m) => m.data?.type === "begin");
    const ends = server.messages.filter((m) => m.data?.type === "end");

    expect(begins.length).toBe(2);
    expect(ends.length).toBe(2);
  });

  test("multi-touch moves are also throttled", async () => {
    transport.streamMultiTouch({ type: "begin", x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 });

    for (let i = 0; i < 40; i++) {
      const spread = 0.2 + (i / 40) * 0.3;
      transport.streamMultiTouch({
        type: "move",
        x1: 0.5 - spread,
        y1: 0.5 - spread,
        x2: 0.5 + spread,
        y2: 0.5 + spread,
      });
    }

    transport.streamMultiTouch({ type: "end", x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 });

    await sleep(100);

    const moves = server.messages.filter(
      (m) => m.type === "stream:multitouch" && m.data?.type === "move",
    );
    const begins = server.messages.filter(
      (m) => m.type === "stream:multitouch" && m.data?.type === "begin",
    );
    const ends = server.messages.filter(
      (m) => m.type === "stream:multitouch" && m.data?.type === "end",
    );

    expect(begins.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.length).toBeLessThan(20);
  });

  test("buttons are never throttled", async () => {
    // Rapid button presses should all go through
    for (let i = 0; i < 5; i++) {
      transport.streamButton("home");
    }

    await sleep(50);

    const buttons = server.messages.filter((m) => m.type === "stream:button");
    expect(buttons.length).toBe(5);
  });
});
