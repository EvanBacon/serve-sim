import { describe, expect, test } from "bun:test";
import { selectServeSimState, type ServeSimState } from "../middleware";

const states: ServeSimState[] = [
  {
    pid: 101,
    port: 3100,
    device: "DEVICE-A",
    url: "http://127.0.0.1:3100",
    streamUrl: "http://127.0.0.1:3100/stream.mjpeg",
    wsUrl: "ws://127.0.0.1:3100/ws",
  },
  {
    pid: 102,
    port: 3101,
    device: "DEVICE-B",
    url: "http://127.0.0.1:3101",
    streamUrl: "http://127.0.0.1:3101/stream.mjpeg",
    wsUrl: "ws://127.0.0.1:3101/ws",
  },
];

describe("selectServeSimState", () => {
  test("keeps existing first-state behavior when no device is requested", () => {
    expect(selectServeSimState(states)?.device).toBe("DEVICE-A");
  });

  test("selects the requested device state", () => {
    expect(selectServeSimState(states, "DEVICE-B")?.device).toBe("DEVICE-B");
  });

  test("returns null when the requested device is not running", () => {
    expect(selectServeSimState(states, "DEVICE-C")).toBeNull();
  });
});
