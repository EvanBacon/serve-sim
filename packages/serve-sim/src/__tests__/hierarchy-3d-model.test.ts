import { describe, expect, test } from "bun:test";
import { axTreeToCapture, normalizeAgentCapture, normalizeRect } from "../hierarchy-3d/model";

const snapshotUrl = (capture: string, id: string) => `/snap/${capture}/${id}`;

function agentNode(id: string, frame: [number, number, number, number], extra: Record<string, unknown> = {}) {
  const [x, y, width, height] = frame;
  return { id, class: "UIView", frame: { x, y, width, height }, alpha: 1, hidden: false, children: [], ...extra };
}

describe("normalizeRect", () => {
  test("accepts finite non-negative rects", () => {
    expect(normalizeRect({ x: 1, y: 2, width: 3, height: 4 })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
  test("rejects missing, non-finite and negative sizes", () => {
    expect(normalizeRect(null)).toBeNull();
    expect(normalizeRect({ x: 0, y: 0, width: Infinity, height: 1 })).toBeNull();
    expect(normalizeRect({ x: 0, y: 0, width: -1, height: 1 })).toBeNull();
    expect(normalizeRect({ x: "0", y: 0, width: 1, height: 1 })).toBeNull();
  });
});

describe("normalizeAgentCapture", () => {
  const payload = {
    protocol: 1,
    source: "injected",
    captureId: "c7",
    pid: 42,
    bundleId: "dev.example",
    screen: { width: 402, height: 874, scale: 3 },
    durationMs: 12.5,
    windows: [
      agentNode("0x1", [0, 0, 402, 874], {
        class: "UIWindow",
        superclasses: ["UIView", "UIResponder"],
        backgroundColor: [1, 1, 1, 1],
        props: { windowLevel: 0, keyWindow: true, nested: { no: 1 } },
        children: [
          agentNode("0x2", [16, 100, 370, 120], {
            class: "UILabel",
            clipsToBounds: true,
            accessibilityIdentifier: "title",
            viewController: "PlacesViewController",
            snapshot: { frame: { x: 16, y: 100, width: 200, height: 40 }, bytes: 900 },
            props: { text: "Hello", textColor: [0, 0, 0, 1] },
            opaque: false,
            tag: 7,
          }),
          { id: "0x3", class: "Broken" }, // no frame → dropped
          agentNode("0x4", [0, 0, 10, 10], { backgroundColor: [2, -1, 0.5, 1] }),
        ],
      }),
    ],
  };

  test("keeps structure, frames, props and snapshot urls", () => {
    const c = normalizeAgentCapture(payload, snapshotUrl);
    expect(c.source).toBe("injected");
    expect(c.captureId).toBe("c7");
    expect(c.pid).toBe(42);
    expect(c.bundleId).toBe("dev.example");
    expect(c.screen).toEqual({ width: 402, height: 874, scale: 3 });
    expect(c.nodeCount).toBe(3);
    expect(c.truncated).toBe(false);
    const win = c.windows[0]!;
    expect(win.class).toBe("UIWindow");
    expect(win.superclasses).toEqual(["UIView", "UIResponder"]);
    expect(win.props).toEqual({ windowLevel: 0, keyWindow: true });
    expect(win.children.map((n) => n.id)).toEqual(["0x2", "0x4"]);
    const label = win.children[0]!;
    expect(label.clipsToBounds).toBe(true);
    expect(label.accessibilityIdentifier).toBe("title");
    expect(label.viewController).toBe("PlacesViewController");
    expect(label.snapshot).toEqual({ frame: { x: 16, y: 100, width: 200, height: 40 }, url: "/snap/c7/0x2" });
    expect(label.props).toEqual({ text: "Hello", textColor: [0, 0, 0, 1], opaque: false, tag: 7 });
    expect(label.zIndex).toBe(0);
  });

  test("clamps colors to 0..1", () => {
    const c = normalizeAgentCapture(payload, snapshotUrl);
    expect(c.windows[0]!.children[1]!.backgroundColor).toEqual([1, 0, 0.5, 1]);
  });

  test("rejects payloads without a safe captureId", () => {
    expect(() => normalizeAgentCapture({ ...payload, captureId: "../x" }, snapshotUrl)).toThrow();
    expect(() => normalizeAgentCapture({ windows: [] }, snapshotUrl)).toThrow();
    expect(() => normalizeAgentCapture("nope", snapshotUrl)).toThrow();
  });

  test("caps very deep trees and flags truncation", () => {
    let leaf: Record<string, unknown> = agentNode("leaf", [0, 0, 1, 1]);
    for (let i = 0; i < 400; i++) leaf = agentNode(`n${i}`, [0, 0, 1, 1], { children: [leaf] });
    const c = normalizeAgentCapture({ captureId: "c1", screen: { width: 1, height: 1 }, windows: [leaf] }, snapshotUrl);
    expect(c.truncated).toBe(true);
    expect(c.nodeCount).toBeLessThan(400);
  });

  test("truncates long strings", () => {
    const c = normalizeAgentCapture(
      { captureId: "c1", windows: [agentNode("0x1", [0, 0, 1, 1], { accessibilityLabel: "x".repeat(2000) })] },
      snapshotUrl,
    );
    expect(c.windows[0]!.accessibilityLabel!.length).toBeLessThan(510);
  });
});

describe("axTreeToCapture", () => {
  test("maps AX nodes to hierarchy nodes with path ids and screen size", () => {
    const raw = [
      {
        AXUniqueId: null,
        AXLabel: "Places",
        AXValue: null,
        enabled: true,
        frame: { x: 0, y: 0, width: 402, height: 874 },
        role_description: "application",
        type: "Application",
        children: [
          { AXUniqueId: "start-trip", AXLabel: "Start trip", AXValue: "", enabled: false, frame: { x: 30, y: 200, width: 120, height: 44 }, role_description: "button", type: "Button", children: [] },
          { AXLabel: "bad", frame: null, children: [] },
        ],
      },
    ];
    const c = axTreeToCapture(raw, { captureId: "ax1", bundleId: "dev.example", pid: 9, screenshotUrl: "/shot" });
    expect(c.source).toBe("accessibility");
    expect(c.screen).toEqual({ width: 402, height: 874 });
    expect(c.screenshotUrl).toBe("/shot");
    expect(c.nodeCount).toBe(2);
    const app = c.windows[0]!;
    expect(app.id).toBe("ax:0");
    expect(app.class).toBe("Application");
    expect(app.accessibilityLabel).toBe("Places");
    const button = app.children[0]!;
    expect(button.id).toBe("ax:0.0");
    expect(button.accessibilityIdentifier).toBe("start-trip");
    expect(button.props).toEqual({ enabled: false, role: "button" });
    expect(button.snapshot).toBeUndefined();
  });

  test("tolerates garbage", () => {
    const c = axTreeToCapture({ nope: true }, { captureId: "ax", bundleId: null, pid: null });
    expect(c.windows).toEqual([]);
    expect(c.screen).toEqual({ width: 1, height: 1 });
  });
});
