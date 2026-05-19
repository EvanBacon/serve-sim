import { describe, expect, test } from "bun:test";
import {
  matchInstalledAppByDisplayName,
  parseForegroundAppLogMessage,
  previewConfigForState,
  rewriteStateForRequestHost,
  selectServeSimState,
  type ServeSimState,
} from "../middleware";

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

describe("previewConfigForState", () => {
  test("returns the full client config shape with device-scoped endpoints", () => {
    const state = states[1]!;
    expect(previewConfigForState(state, "/preview", "/bin/serve-sim", "token-xyz")).toEqual({
      ...state,
      basePath: "/preview",
      logsEndpoint: "/preview/logs?device=DEVICE-B",
      appStateEndpoint: "/preview/appstate?device=DEVICE-B",
      axEndpoint: "/preview/ax?device=DEVICE-B",
      devtoolsEndpoint: "/preview/devtools?device=DEVICE-B",
      serveSimBin: "/bin/serve-sim",
      gridApiEndpoint: "/preview/grid/api",
      gridStartEndpoint: "/preview/grid/api/start",
      gridShutdownEndpoint: "/preview/grid/api/shutdown",
      gridMemoryEndpoint: "/preview/grid/api/memory",
      previewEndpoint: "/preview",
      execToken: "token-xyz",
    });
  });
});

describe("rewriteStateForRequestHost", () => {
  const state = states[0]!;

  test("returns the state unchanged when host header is missing", () => {
    expect(rewriteStateForRequestHost(state, undefined)).toBe(state);
  });

  test("returns the state unchanged when the request is loopback", () => {
    expect(rewriteStateForRequestHost(state, "localhost:8081")).toBe(state);
    expect(rewriteStateForRequestHost(state, "127.0.0.1:8081")).toBe(state);
    expect(rewriteStateForRequestHost(state, "[::1]:8081")).toBe(state);
  });

  test("rewrites the host portion for a LAN viewer, keeping the helper port", () => {
    expect(rewriteStateForRequestHost(state, "192.168.1.42:8081")).toEqual({
      ...state,
      url: "http://192.168.1.42:3100",
      streamUrl: "http://192.168.1.42:3100/stream.mjpeg",
      wsUrl: "ws://192.168.1.42:3100/ws",
    });
  });

  test("rewrites the host portion for a tunneled hostname (no port)", () => {
    expect(rewriteStateForRequestHost(state, "tunnel.example.com")).toEqual({
      ...state,
      url: "http://tunnel.example.com:3100",
      streamUrl: "http://tunnel.example.com:3100/stream.mjpeg",
      wsUrl: "ws://tunnel.example.com:3100/ws",
    });
  });
});

describe("parseForegroundAppLogMessage", () => {
  test("extracts bundle id and pid from SpringBoard foreground logs", () => {
    expect(
      parseForegroundAppLogMessage(
        "[app<com.example.SampleApp>:43117] Setting process visibility to: Foreground",
      ),
    ).toEqual({ bundleId: "com.example.SampleApp", pid: 43117 });
  });

  test("ignores unrelated log messages", () => {
    expect(parseForegroundAppLogMessage("Setting process visibility to: Background")).toBeNull();
  });
});

describe("matchInstalledAppByDisplayName", () => {
  test("matches the AX application label to an installed app bundle id", () => {
    expect(
      matchInstalledAppByDisplayName(
        {
          "com.example.SampleApp": {
            CFBundleDisplayName: "Sample App",
            CFBundleIdentifier: "com.example.SampleApp",
          },
          "com.apple.mobilesafari": {
            CFBundleDisplayName: "Safari",
            CFBundleIdentifier: "com.apple.mobilesafari",
          },
        },
        "Sample App",
      ),
    ).toBe("com.example.SampleApp");
  });

  test("falls back to bundle name fields and normalizes whitespace", () => {
    expect(
      matchInstalledAppByDisplayName(
        {
          "com.example.App": {
            CFBundleName: "Example App",
          },
        },
        " example   app ",
      ),
    ).toBe("com.example.App");
  });
});
