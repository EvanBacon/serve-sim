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
      appStateEndpoint: "/preview/appstate?device=DEVICE-B",
      eventLogEndpoint: "/preview/api/event-log?device=DEVICE-B",
      eventLogEventsEndpoint: "/preview/api/event-log/events?device=DEVICE-B",
      axEndpoint: "/preview/ax?device=DEVICE-B",
      cameraStatusEndpoint: "/preview/helper/DEVICE-B/camera/status",
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

  test("omits codec when none is pinned", () => {
    expect(
      "codec" in previewConfigForState(states[0]!, "/preview", "/bin/serve-sim", "token-xyz"),
    ).toBe(false);
  });

  test("pins the stream codec in the client config", () => {
    expect(
      previewConfigForState(states[0]!, "/preview", "/bin/serve-sim", "token-xyz", "mjpeg").codec,
    ).toBe("mjpeg");
  });

  test("includes configured preview startup state", () => {
    expect(
      previewConfigForState(
        states[0]!,
        "/preview",
        "/bin/serve-sim",
        "token-xyz",
        undefined,
        false,
        { panes: ["devices", "tools"], fit: true },
      ).initialState,
    ).toEqual({ panes: ["devices", "tools"], fit: true });
  });

  test("builds the camera status endpoint correctly at the root mount", () => {
    expect(
      previewConfigForState(states[0]!, "", "/bin/serve-sim", "token-xyz").cameraStatusEndpoint,
    ).toBe("/helper/DEVICE-A/camera/status");
  });
});

describe("rewriteStateForRequestHost", () => {
  const state = states[0]!;
  // Proxy mode routes browsers through the preview's same-origin `/helper`
  // proxy; the trailing args are (base, protocol, proxy).
  const proxy = (host: string | undefined, base = "", protocol: "http" | "https" = "http") =>
    rewriteStateForRequestHost(state, host, base, protocol, true);

  test("returns the state unchanged when host header is missing", () => {
    expect(rewriteStateForRequestHost(state, undefined)).toBe(state);
    expect(proxy(undefined)).toBe(state);
  });

  describe("default (direct helper URLs, no proxy)", () => {
    test("leaves loopback viewers on the helper's own port", () => {
      expect(rewriteStateForRequestHost(state, "localhost:3200")).toBe(state);
      expect(rewriteStateForRequestHost(state, "127.0.0.1:3200")).toBe(state);
      expect(rewriteStateForRequestHost(state, "[::1]:3200")).toBe(state);
    });

    test("swaps the loopback host for LAN/tunnel viewers, keeping the helper port", () => {
      expect(rewriteStateForRequestHost(state, "192.168.1.42:3200")).toEqual({
        ...state,
        url: "http://192.168.1.42:3100",
        streamUrl: "http://192.168.1.42:3100/stream.mjpeg",
        wsUrl: "ws://192.168.1.42:3100/ws",
      });
      expect(rewriteStateForRequestHost(state, "tunnel.example.com")).toEqual({
        ...state,
        url: "http://tunnel.example.com:3100",
        streamUrl: "http://tunnel.example.com:3100/stream.mjpeg",
        wsUrl: "ws://tunnel.example.com:3100/ws",
      });
    });
  });

  describe("proxy mode (same-origin /helper)", () => {
    test("rewrites loopback viewers through the same-origin helper proxy", () => {
      expect(proxy("localhost:3200")).toEqual({
        ...state,
        url: "http://localhost:3200/helper/DEVICE-A",
        streamUrl: "http://localhost:3200/helper/DEVICE-A/stream.mjpeg",
        wsUrl: "ws://localhost:3200/helper/DEVICE-A/ws",
      });
      expect(proxy("[::1]:3200")).toEqual({
        ...state,
        url: "http://[::1]:3200/helper/DEVICE-A",
        streamUrl: "http://[::1]:3200/helper/DEVICE-A/stream.mjpeg",
        wsUrl: "ws://[::1]:3200/helper/DEVICE-A/ws",
      });
    });

    test("rewrites LAN/tunnel viewers through the same-origin helper proxy", () => {
      expect(proxy("192.168.1.42:3200")).toEqual({
        ...state,
        url: "http://192.168.1.42:3200/helper/DEVICE-A",
        streamUrl: "http://192.168.1.42:3200/helper/DEVICE-A/stream.mjpeg",
        wsUrl: "ws://192.168.1.42:3200/helper/DEVICE-A/ws",
      });
      expect(proxy("tunnel.example.com")).toEqual({
        ...state,
        url: "http://tunnel.example.com/helper/DEVICE-A",
        streamUrl: "http://tunnel.example.com/helper/DEVICE-A/stream.mjpeg",
        wsUrl: "ws://tunnel.example.com/helper/DEVICE-A/ws",
      });
    });

    test("preserves middleware mount paths in helper proxy URLs", () => {
      expect(proxy("localhost:8081", "/preview")).toEqual({
        ...state,
        url: "http://localhost:8081/preview/helper/DEVICE-A",
        streamUrl: "http://localhost:8081/preview/helper/DEVICE-A/stream.mjpeg",
        wsUrl: "ws://localhost:8081/preview/helper/DEVICE-A/ws",
      });
    });

    test("uses https/wss when the request was forwarded as https", () => {
      expect(proxy("tunnel.example.com", "", "https")).toEqual({
        ...state,
        url: "https://tunnel.example.com/helper/DEVICE-A",
        streamUrl: "https://tunnel.example.com/helper/DEVICE-A/stream.mjpeg",
        wsUrl: "wss://tunnel.example.com/helper/DEVICE-A/ws",
      });
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
