import { describe, expect, test } from "bun:test";
import { proxyPreviewConfigForBrowser } from "../client/utils/preview-config";

const baseConfig = {
  pid: 101,
  port: 3100,
  device: "DEVICE-A",
  url: "http://127.0.0.1:3100",
  streamUrl: "http://127.0.0.1:3100/stream.mjpeg",
  wsUrl: "ws://127.0.0.1:3100/ws",
  basePath: "",
  execToken: "token",
  // The server only re-anchors helper URLs to the browser origin when it opted
  // into same-origin proxying.
  proxyHelpers: true as const,
};

describe("proxyPreviewConfigForBrowser", () => {
  test("maps raw helper URLs to same-origin root helper paths", () => {
    expect(
      proxyPreviewConfigForBrowser(baseConfig as NonNullable<Window["__SIM_PREVIEW__"]>, {
        protocol: "http:",
        host: "example.test:3200",
      }),
    ).toEqual({
      ...baseConfig,
      url: "http://example.test:3200/helper/DEVICE-A",
      streamUrl: "http://example.test:3200/helper/DEVICE-A/stream.mjpeg",
      wsUrl: "ws://example.test:3200/helper/DEVICE-A/ws",
    });
  });

  test("preserves middleware mount paths and uses secure websocket on https", () => {
    expect(
      proxyPreviewConfigForBrowser({
        ...baseConfig,
        basePath: "/.sim",
      } as NonNullable<Window["__SIM_PREVIEW__"]>, {
        protocol: "https:",
        host: "tunnel.example.com",
      }),
    ).toEqual({
      ...baseConfig,
      basePath: "/.sim",
      url: "https://tunnel.example.com/.sim/helper/DEVICE-A",
      streamUrl: "https://tunnel.example.com/.sim/helper/DEVICE-A/stream.mjpeg",
      wsUrl: "wss://tunnel.example.com/.sim/helper/DEVICE-A/ws",
    });
  });

  test("leaves the config untouched when the server didn't opt into proxying", () => {
    const direct = { ...baseConfig, proxyHelpers: undefined } as NonNullable<Window["__SIM_PREVIEW__"]>;
    expect(
      proxyPreviewConfigForBrowser(direct, { protocol: "http:", host: "example.test:3200" }),
    ).toBe(direct);
  });
});
