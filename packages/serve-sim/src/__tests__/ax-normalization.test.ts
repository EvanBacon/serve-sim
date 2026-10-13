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
});
