import { describe, expect, test } from "bun:test";
import {
  collectAxSnapshot,
  isUsableAxSnapshot,
  normalizeAxTree,
} from "../ax";

type RawAxeNode = Parameters<typeof normalizeAxTree>[0][number];

function axeNode(overrides: Partial<RawAxeNode> = {}): RawAxeNode {
  return {
    AXFrame: "{{0, 0}, {1, 1}}",
    AXLabel: null,
    AXUniqueId: null,
    AXValue: null,
    children: [],
    content_required: false,
    custom_actions: [],
    enabled: true,
    frame: { x: 0, y: 0, width: 1, height: 1 },
    help: null,
    pid: 1,
    role: "AXGroup",
    role_description: "Group",
    subrole: null,
    title: null,
    type: "Group",
    ...overrides,
  };
}

describe("AX normalization", () => {
  test("normalizeAxTree extracts drawable elements and skips screen root", () => {
    const snapshot = [
      axeNode({
        frame: { x: 0, y: 0, width: 402, height: 874 },
        type: "Application",
        children: [
          axeNode({
            AXUniqueId: "Safari",
            AXLabel: "Safari",
            role_description: "button",
            frame: { x: 123, y: 771, width: 68, height: 68 },
          }),
          axeNode({
            AXUniqueId: "Search",
            AXLabel: "Search",
            role_description: "slider",
            AXValue: "Page 1 of 2",
            frame: { x: 162, y: 703.5, width: 78, height: 30 },
          }),
        ],
      }),
    ];

    const normalized = normalizeAxTree(snapshot);

    expect(normalized.screen).toEqual({ width: 402, height: 874 });
    expect(normalized.elements).toHaveLength(2);
    expect(normalized.elements[0]?.label).toBe("Safari");
    expect(normalized.elements[1]?.value).toBe("Page 1 of 2");
  });

  test("normalizeAxTree keeps duplicate-looking elements from axe", () => {
    const duplicateElement = axeNode({
      AXLabel: "Photo",
      role_description: "image",
      type: "Image",
      frame: { x: 12, y: 24, width: 40, height: 40 },
    });
    const snapshot = [
      axeNode({
        frame: { x: 0, y: 0, width: 402, height: 874 },
        type: "Application",
        children: [duplicateElement, duplicateElement],
      }),
    ];

    const normalized = normalizeAxTree(snapshot);

    expect(normalized.elements).toHaveLength(2);
  });

  test("normalizeAxTree preserves out-of-bounds axe frames", () => {
    const snapshot = [
      axeNode({
        frame: { x: 0, y: 0, width: 402, height: 874 },
        type: "Application",
        children: [
          axeNode({
            AXLabel: "Add attachment…",
            role_description: "button",
            type: "Button",
            frame: { x: 20, y: 832.5, width: 362, height: 52 },
          }),
        ],
      }),
    ];

    const normalized = normalizeAxTree(snapshot);

    expect(normalized.elements[0]?.frame).toEqual({
      x: 20,
      y: 832.5,
      width: 362,
      height: 52,
    });
  });

  test("isUsableAxSnapshot rejects empty snapshots", () => {
    expect(
      isUsableAxSnapshot({
        screen: { width: 1, height: 1 },
        elements: [],
      }),
    ).toBe(false);
  });

  test("collectAxSnapshot reports missing AXe without throwing", async () => {
    const path = process.env.PATH;
    process.env.PATH = "/tmp/serve-sim-no-axe";
    try {
      const snapshot = await collectAxSnapshot("missing-udid");

      expect(snapshot.elements).toHaveLength(0);
      expect(snapshot.errors?.[0]).toContain("AXe is not installed");
      expect(snapshot.errors?.[0]).toContain("https://github.com/cameroncooke/AXe");
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });
});
