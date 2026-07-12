import { describe, expect, test } from "bun:test";
import {
  encodeWsMessage,
  enqueueWsMessage,
  flushWsMessageQueue,
  sendOrQueueWsMessage,
  WS_OPEN_READY_STATE,
  type WsSendTarget,
} from "../client/utils/ws-send-queue";

function sentPayload(data: Uint8Array) {
  return {
    tag: data[0],
    payload: JSON.parse(new TextDecoder().decode(data.subarray(1))),
  };
}

function openWs() {
  const sent: ArrayBuffer[] = [];
  const ws: WsSendTarget = {
    readyState: WS_OPEN_READY_STATE,
    send(data) {
      sent.push(data);
    },
  };
  return { ws, sent };
}

describe("ws send queue", () => {
  test("encodes a tagged JSON message", () => {
    expect(sentPayload(encodeWsMessage(0x03, { type: "begin", x: 0.5 }))).toEqual({
      tag: 0x03,
      payload: { type: "begin", x: 0.5 },
    });
  });

  test("queues messages while the WebSocket is not open", () => {
    const queue = sendOrQueueWsMessage(null, [], 0x03, { type: "begin" }, 1_000);
    expect(queue).toEqual([{ tag: 0x03, payload: { type: "begin" }, createdAt: 1_000 }]);
  });

  test("flushes queued messages before the current open-socket message", () => {
    const { ws, sent } = openWs();
    const queue = sendOrQueueWsMessage(
      ws,
      [{ tag: 0x03, payload: { type: "begin" }, createdAt: 1_000 }],
      0x03,
      { type: "end" },
      1_100,
    );

    expect(queue).toEqual([]);
    expect(sent.map((data) => sentPayload(new Uint8Array(data)))).toEqual([
      { tag: 0x03, payload: { type: "begin" } },
      { tag: 0x03, payload: { type: "end" } },
    ]);
  });

  test("drops stale queued messages instead of replaying old gestures", () => {
    const { ws, sent } = openWs();
    const queue = flushWsMessageQueue(
      ws,
      [{ tag: 0x03, payload: { type: "begin" }, createdAt: 1_000 }],
      3_000,
    );

    expect(queue).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("caps the queue by trimming oldest messages", () => {
    const queue = enqueueWsMessage(
      [
        { tag: 0x03, payload: { i: 1 }, createdAt: 1 },
        { tag: 0x03, payload: { i: 2 }, createdAt: 2 },
      ],
      { tag: 0x03, payload: { i: 3 }, createdAt: 3 },
      2,
    );

    expect(queue.map((message) => message.payload)).toEqual([{ i: 2 }, { i: 3 }]);
  });
});
