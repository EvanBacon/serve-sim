import { describe, expect, test } from "bun:test";

import { normalizeAxTree, type RawAxeNode } from "../ax";

function node(overrides: Partial<RawAxeNode> = {}): RawAxeNode {
  return {
    AXUniqueId: null,
    AXLabel: null,
    AXValue: null,
    enabled: true,
    frame: { x: 0, y: 0, width: 0, height: 0 },
    role_description: "group",
    type: "Group",
    children: [],
    ...overrides,
  };
}

describe("normalizeAxTree", () => {
  test("filters oversized anonymous groups without dropping valid controls", () => {
    const tree = normalizeAxTree([
      node({
        AXLabel: "FoodwayApp",
        frame: { x: 0, y: 0, width: 402, height: 874 },
        role_description: "application",
        type: "Application",
        children: [
          node({
            frame: { x: -119, y: 0, width: 600, height: 874 },
          }),
          node({
            AXLabel: "Řádek panelů",
            frame: { x: 0, y: 791, width: 402, height: 83 },
          }),
          node({
            AXLabel: "Profil",
            AXUniqueId: "person.crop.circle.fill",
            frame: { x: 25, y: 795, width: 74, height: 54 },
            role_description: "tab",
            type: "RadioButton",
            AXValue: "0",
          }),
        ],
      }),
    ]);

    expect(tree.elements.map((element) => element.path)).toEqual(["0.1", "0.2"]);
    expect(tree.elements.find((element) => element.path === "0.1")?.label).toBe("Řádek panelů");
    expect(tree.elements.find((element) => element.path === "0.2")?.label).toBe("Profil");
  });

  test("still visits children of a filtered oversized group", () => {
    const tree = normalizeAxTree([
      node({
        frame: { x: 0, y: 0, width: 402, height: 874 },
        role_description: "application",
        type: "Application",
        children: [
          node({
            frame: { x: -119, y: 0, width: 600, height: 874 },
            children: [
              node({
                AXLabel: "Continue",
                frame: { x: 20, y: 700, width: 362, height: 50 },
                role_description: "button",
                type: "Button",
              }),
            ],
          }),
        ],
      }),
    ]);

    expect(tree.elements.map((element) => element.path)).toEqual(["0.0.0"]);
    expect(tree.elements[0]?.label).toBe("Continue");
  });

  test("keeps oversized groups that carry a label or value, and normal-sized anonymous groups", () => {
    const oversized = { x: -119, y: 0, width: 600, height: 874 };
    const tree = normalizeAxTree([
      node({
        frame: { x: 0, y: 0, width: 402, height: 874 },
        role_description: "application",
        type: "Application",
        children: [
          node({ AXLabel: "Carousel", frame: oversized }),
          node({ AXValue: "Page 1 of 3", frame: oversized }),
          node({ frame: { x: 0, y: 100, width: 402, height: 300 } }),
          node({ AXLabel: "   ", frame: oversized }),
        ],
      }),
    ]);

    expect(tree.elements.map((element) => element.path)).toEqual(["0.0", "0.1", "0.2"]);
  });

  test("filters a full-height anonymous group that is not wider than the screen", () => {
    const tree = normalizeAxTree([
      node({
        frame: { x: 0, y: 0, width: 402, height: 874 },
        role_description: "application",
        type: "Application",
        children: [
          node({
            frame: { x: 0, y: 0, width: 250, height: 873.99 },
            children: [
              node({
                AXLabel: "Settings",
                frame: { x: 20, y: 100, width: 210, height: 44 },
                role_description: "button",
                type: "Button",
              }),
            ],
          }),
        ],
      }),
    ]);

    expect(tree.elements.map((element) => element.path)).toEqual(["0.0.0"]);
    expect(tree.elements[0]?.label).toBe("Settings");
  });

  test("keeps a shorter anonymous group and a full-height group with a label", () => {
    const tree = normalizeAxTree([
      node({
        frame: { x: 0, y: 0, width: 402, height: 874 },
        role_description: "application",
        type: "Application",
        children: [
          node({ frame: { x: 0, y: 0, width: 250, height: 820 } }),
          node({ AXLabel: "Sidebar", frame: { x: 0, y: 0, width: 250, height: 873.99 } }),
        ],
      }),
    ]);

    expect(tree.elements.map((element) => element.path)).toEqual(["0.0", "0.1"]);
    expect(tree.elements[1]?.label).toBe("Sidebar");
  });
});
