import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { normalizeAxTree, type RawAxeNode } from "../ax";
import { axUrlFromStreamUrl, fetchAxSnapshot } from "../ax-cli";

function rawNode(overrides: Partial<RawAxeNode> = {}): RawAxeNode {
  return {
    AXUniqueId: null,
    AXLabel: null,
    AXValue: null,
    enabled: true,
    frame: { x: 0, y: 0, width: 100, height: 50 },
    role_description: "button",
    type: "Button",
    children: [],
    ...overrides,
  };
}

const SCREEN = { x: 0, y: 0, width: 393, height: 852 };

describe("axUrlFromStreamUrl", () => {
  test("maps the stream URL to the sibling /ax endpoint", () => {
    expect(axUrlFromStreamUrl("http://127.0.0.1:3200/helper/UDID-1/stream.mjpeg"))
      .toBe("http://127.0.0.1:3200/helper/UDID-1/ax");
  });

  test("only rewrites the trailing path segment", () => {
    expect(axUrlFromStreamUrl("http://127.0.0.1:3200/stream.mjpeg/helper/UDID/stream.mjpeg"))
      .toBe("http://127.0.0.1:3200/stream.mjpeg/helper/UDID/ax");
  });
});

describe("normalizeAxTree", () => {
  test("flattens the tree into elements with role, label, value, enabled state, and frame", () => {
    const roots: RawAxeNode[] = [
      rawNode({
        frame: SCREEN,
        role_description: "application",
        type: "Application",
        children: [
          rawNode({
            AXUniqueId: "login-button",
            AXLabel: "Log in",
            AXValue: "",
            role_description: "button",
            type: "Button",
            frame: { x: 20, y: 700, width: 353, height: 44 },
          }),
          rawNode({
            AXLabel: "Username",
            AXValue: "bacon",
            role_description: "text field",
            type: "TextField",
            enabled: false,
            frame: { x: 20, y: 200, width: 353, height: 44 },
          }),
        ],
      }),
    ];

    const snapshot = normalizeAxTree(roots);
    expect(snapshot.screen).toEqual({ width: SCREEN.width, height: SCREEN.height });
    // The screen-sized root is dropped; only real elements remain.
    expect(snapshot.elements).toHaveLength(2);
    expect(snapshot.elements[0]).toEqual({
      id: "login-button",
      path: "0.0",
      label: "Log in",
      value: "",
      role: "button",
      type: "Button",
      enabled: true,
      frame: { x: 20, y: 700, width: 353, height: 44 },
    });
    expect(snapshot.elements[1]).toMatchObject({
      id: "0.1", // falls back to the tree path when AXUniqueId is null
      label: "Username",
      value: "bacon",
      role: "text field",
      enabled: false,
    });
  });

  test("caps the element count so pathological trees stay bounded", () => {
    const children = Array.from({ length: 600 }, (_, i) =>
      rawNode({ AXLabel: `Row ${i}`, frame: { x: 0, y: i, width: 100, height: 1 } }));
    const snapshot = normalizeAxTree([rawNode({ frame: SCREEN, children })]);
    expect(snapshot.elements.length).toBeLessThanOrEqual(500);
  });
});

describe("fetchAxSnapshot", () => {
  let server: Server;
  let streamUrl: string;
  let status = 200;
  let body: unknown = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url !== "/helper/UDID-TEST/ax") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    streamUrl = `http://127.0.0.1:${port}/helper/UDID-TEST/stream.mjpeg`;
  });

  afterAll(() => {
    server.close();
  });

  test("fetches the raw tree and returns the normalized snapshot", async () => {
    status = 200;
    body = [
      rawNode({
        frame: SCREEN,
        children: [rawNode({ AXUniqueId: "ok", AXLabel: "OK", frame: { x: 10, y: 10, width: 80, height: 40 } })],
      }),
    ];

    const snapshot = await fetchAxSnapshot(streamUrl);
    expect(snapshot.screen).toEqual({ width: SCREEN.width, height: SCREEN.height });
    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]).toMatchObject({ id: "ok", label: "OK", role: "button", enabled: true });
  });

  test("surfaces the helper's message when AX is unavailable (503)", async () => {
    status = 503;
    body = { error: "ax_unavailable", message: "Accessibility unavailable on this simulator." };

    await expect(fetchAxSnapshot(streamUrl)).rejects.toThrow(
      "Accessibility unavailable on this simulator.",
    );
  });
});
