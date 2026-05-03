import { describe, expect, test } from "bun:test";
import { buildSimPreviewConfig, selectServeSimState, type ServeSimState } from "../middleware";

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

describe("buildSimPreviewConfig", () => {
  test("injects middleware endpoints without helper URLs when no state is running", () => {
    expect(buildSimPreviewConfig("/.sim", null)).toEqual({
      basePath: "/.sim",
      endpoints: {
        api: "/.sim/api",
        exec: "/.sim/exec",
      },
    });
  });

  test("separates middleware endpoints from helper stream/control URLs", () => {
    expect(buildSimPreviewConfig("/.sim", states[1]!)).toEqual({
      basePath: "/.sim",
      endpoints: {
        api: "/.sim/api",
        exec: "/.sim/exec",
        logs: "/.sim/logs?device=DEVICE-B",
        appState: "/.sim/appstate?device=DEVICE-B",
      },
      state: states[1],
      helper: {
        url: "http://127.0.0.1:3101",
        stream: "http://127.0.0.1:3101/stream.mjpeg",
        ws: "ws://127.0.0.1:3101/ws",
        config: "http://127.0.0.1:3101/config",
      },
    });
  });

  test("uses root-relative middleware endpoints for root-mounted preview", () => {
    expect(buildSimPreviewConfig("", states[0]!).endpoints).toEqual({
      api: "/api",
      exec: "/exec",
      logs: "/logs?device=DEVICE-A",
      appState: "/appstate?device=DEVICE-A",
    });
  });
});
