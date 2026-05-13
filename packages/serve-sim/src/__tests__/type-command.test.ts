import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import type { ServerWebSocket } from "bun";
import { textToKeyEvents, UnsupportedCharacterError, sendKeyEventsToWs } from "../text-to-keys";

describe("textToKeyEvents", () => {
  it("emits down/up for a single lowercase letter", () => {
    expect(textToKeyEvents("a")).toEqual([
      { type: "down", usage: 0x04 },
      { type: "up", usage: 0x04 },
    ]);
  });

  it("wraps shifted characters with left-shift down/up", () => {
    // 'A' = shift + KeyA(0x04)
    expect(textToKeyEvents("A")).toEqual([
      { type: "down", usage: 0xe1 },
      { type: "down", usage: 0x04 },
      { type: "up", usage: 0x04 },
      { type: "up", usage: 0xe1 },
    ]);
  });

  it("maps digits and shifted symbols on the digits row", () => {
    // '1' = 0x1e (no shift); '!' = shift + 0x1e
    expect(textToKeyEvents("1!")).toEqual([
      { type: "down", usage: 0x1e },
      { type: "up", usage: 0x1e },
      { type: "down", usage: 0xe1 },
      { type: "down", usage: 0x1e },
      { type: "up", usage: 0x1e },
      { type: "up", usage: 0xe1 },
    ]);
    // '0' = 0x27
    expect(textToKeyEvents("0")[0]).toEqual({ type: "down", usage: 0x27 });
  });

  it("maps space, newline, and tab to their HID codes", () => {
    expect(textToKeyEvents(" ")[0]).toEqual({ type: "down", usage: 0x2c });
    expect(textToKeyEvents("\n")[0]).toEqual({ type: "down", usage: 0x28 });
    expect(textToKeyEvents("\t")[0]).toEqual({ type: "down", usage: 0x2b });
  });

  it("normalizes CRLF to a single Enter press", () => {
    expect(textToKeyEvents("\r\n")).toEqual([
      { type: "down", usage: 0x28 },
      { type: "up", usage: 0x28 },
    ]);
  });

  it("covers common punctuation in both plain and shifted forms", () => {
    // ; → 0x33, : → shift+0x33; / → 0x38, ? → shift+0x38
    expect(textToKeyEvents(";")[0]).toEqual({ type: "down", usage: 0x33 });
    expect(textToKeyEvents(":")[0]).toEqual({ type: "down", usage: 0xe1 });
    expect(textToKeyEvents("/")[0]).toEqual({ type: "down", usage: 0x38 });
    expect(textToKeyEvents("?")[1]).toEqual({ type: "down", usage: 0x38 });
  });

  it("throws UnsupportedCharacterError for non-US-keyboard chars", () => {
    expect(() => textToKeyEvents("é")).toThrow(UnsupportedCharacterError);
    expect(() => textToKeyEvents("emoji 🙂 here")).toThrow(UnsupportedCharacterError);
  });

  it("produces 4 events for an uppercase letter (shift wraps key)", () => {
    expect(textToKeyEvents("A").length).toBe(4);
  });

  it("expands 'Hi!' to the expected event count", () => {
    // H: shift+down+up+shift(4) ; i: down+up(2) ; !: shift+down+up+shift(4) → 10
    expect(textToKeyEvents("Hi!").length).toBe(10);
  });
});

// ─── E2E: send key events over WS to a fake serve-sim server ───
//
// Spins up a Bun WebSocket server that mimics the serve-sim helper's input
// channel, runs the type-command's send path, and asserts the bytes received
// match what `textToKeyEvents` produced.

describe("sendKeyEventsToWs e2e", () => {
  let server: ReturnType<typeof Bun.serve>;
  let wsUrl: string;
  let received: Array<{ opcode: number; payload: unknown }>;

  beforeAll(() => {
    received = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("not a ws", { status: 400 });
      },
      websocket: {
        message(_ws: ServerWebSocket<unknown>, data: string | Buffer) {
          const buf = typeof data === "string" ? Buffer.from(data) : data;
          const opcode = buf[0]!;
          const json = buf.slice(1).toString("utf8");
          received.push({ opcode, payload: JSON.parse(json) });
        },
      },
    });
    wsUrl = `ws://127.0.0.1:${server.port}/ws`;
  });

  afterAll(() => {
    server.stop(true);
  });

  it("sends one 0x06 WS frame per key event with the JSON payload", async () => {
    received.length = 0;
    const events = textToKeyEvents("aB");
    // 'a' (2 events) + 'B' (4 events) = 6 frames
    expect(events.length).toBe(6);

    await sendKeyEventsToWs(wsUrl, events, /* perEventDelayMs */ 0);

    // Wait briefly for the server to drain all frames before we assert. The
    // WS client closes only after a 50ms tail in sendKeyEventsToWs, so frames
    // should already be flushed by the time the promise resolves — but give
    // the event loop one tick to deliver the final `message` callbacks.
    await new Promise((r) => setTimeout(r, 20));

    expect(received.length).toBe(6);
    for (const frame of received) {
      expect(frame.opcode).toBe(0x06);
    }
    expect(received.map((f) => f.payload)).toEqual(events);
  });

  it("rejects when the WS endpoint is unreachable", async () => {
    // Port 1 is virtually never accepting connections from a normal process.
    let err: unknown;
    try {
      await sendKeyEventsToWs("ws://127.0.0.1:1/ws", [{ type: "down", usage: 0x04 }], 0);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/WebSocket/);
  });
});
