import { describe, expect, test } from "bun:test";
import type { HierarchyNode } from "../hierarchy-3d/model";
import { expandableSubtreeIds, flattenTree, initialCollapsed, nodeKind, nodeSummary, shortClassName, treeKeyAction } from "../client/hierarchy-3d/tree";

function node(id: string, children: HierarchyNode[] = [], extra: Partial<HierarchyNode> = {}): HierarchyNode {
  return {
    id,
    class: "UIView",
    superclasses: [],
    frame: { x: 0, y: 0, width: 10, height: 10 },
    alpha: 1,
    hidden: false,
    clipsToBounds: false,
    backgroundColor: null,
    zIndex: 0,
    props: {},
    children,
    ...extra,
  };
}

// w
// ├─ a
// │  ├─ a1 (label "Hello")
// │  └─ a2
// └─ b
//    └─ b1
const tree = () => [
  node("w", [
    node("a", [node("a1", [], { class: "UILabel", props: { text: "Hello" } }), node("a2")]),
    node("b", [node("b1", [], { accessibilityIdentifier: "hero-card" })]),
  ], { class: "UIWindow" }),
];
const ids = (rows: { node: HierarchyNode }[]) => rows.map((r) => r.node.id);

describe("shortClassName", () => {
  test("strips the Swift module prefix", () => {
    expect(shortClassName("Places.HeaderView")).toBe("HeaderView");
    expect(shortClassName("UIKit.NavigationBarContentView")).toBe("NavigationBarContentView");
    expect(shortClassName("UILabel")).toBe("UILabel");
    expect(shortClassName("Mod.Box<Mod.Item>")).toBe("Box<Mod.Item>");
  });
  test("demangles Swift runtime class names", () => {
    expect(shortClassName("_TtC6Places10HeaderView")).toBe("HeaderView");
    expect(shortClassName("_TtCC5UIKit19NavigationButtonBar15ItemWrapperView")).toBe("NavigationButtonBar.ItemWrapperView");
    expect(shortClassName("_TtCC5UIKit12_UITabButtonP33_4EA307C86E0356016F55ED2F1518661D5Label")).toBe("_UITabButton.Label");
    expect(shortClassName("_TtCE5UIKitCSo17_UILiquidLensViewP33_4C400BD973F5E4E0B779D1A21A7AEB2714ClearGlassView")).toBe("_UILiquidLensView.ClearGlassView");
    expect(shortClassName("_TtGC5UIKitP10$186d42c1422FloatingBarHostingViewVS_20FloatingBarContainer_")).toBe("FloatingBarHostingView<FloatingBarContainer>");
  });
  test("leaves malformed mangled names alone", () => {
    expect(shortClassName("_Tt99X")).toBe("_Tt99X");
  });
});

describe("nodeKind", () => {
  test("classifies by class and superclass chain", () => {
    expect(nodeKind({ class: "UIWindow", superclasses: ["UIView"] })).toBe("window");
    expect(nodeKind({ class: "UISegmentLabel", superclasses: ["UILabel", "UIView"] })).toBe("text");
    expect(nodeKind({ class: "_UIListContentImageView", superclasses: ["UIImageView", "UIView"] })).toBe("image");
    expect(nodeKind({ class: "UITableView", superclasses: ["UIScrollView", "UIView"] })).toBe("scroll");
    expect(nodeKind({ class: "_UIModernBarButton", superclasses: ["UIButton", "UIControl", "UIView"] })).toBe("control");
    expect(nodeKind({ class: "Places.HeaderView", superclasses: ["UIView"] })).toBe("view");
  });
  test("classifies accessibility element types", () => {
    expect(nodeKind({ class: "Button", superclasses: [] })).toBe("control");
    expect(nodeKind({ class: "StaticText", superclasses: [] })).toBe("text");
  });
});

describe("nodeSummary", () => {
  test("prefers accessibility id, then text, then label", () => {
    expect(nodeSummary(node("x", [], { accessibilityIdentifier: "id", props: { text: "t" } }))).toBe("id");
    expect(nodeSummary(node("x", [], { props: { title: "Save" }, accessibilityLabel: "l" }))).toBe("Save");
    expect(nodeSummary(node("x", [], { accessibilityLabel: "l" }))).toBe("l");
    expect(nodeSummary(node("x"))).toBe("");
  });
});

describe("flattenTree", () => {
  test("emits visible rows with depth, parent and expansion", () => {
    const rows = flattenTree(tree(), new Set(["b"]));
    expect(ids(rows)).toEqual(["w", "a", "a1", "a2", "b"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 2, 1]);
    expect(rows.map((r) => r.parentId)).toEqual([null, "w", "a", "a", "w"]);
    expect(rows.find((r) => r.node.id === "b")).toMatchObject({ hasChildren: true, expanded: false });
    expect(rows.find((r) => r.node.id === "a1")).toMatchObject({ hasChildren: false, expanded: false });
  });
  test("filtering keeps matches with their ancestor chain as context", () => {
    const rows = flattenTree(tree(), new Set(["a", "b"]), "hero");
    expect(ids(rows)).toEqual(["w", "b", "b1"]);
    expect(rows.map((r) => r.context)).toEqual([true, true, false]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(rows.every((r) => !r.hasChildren)).toBe(true);
  });
  test("filter matches short class names, text and is case-insensitive", () => {
    expect(ids(flattenTree(tree(), new Set(), "HELLO"))).toEqual(["w", "a", "a1"]);
    expect(ids(flattenTree(tree(), new Set(), "uilabel"))).toEqual(["w", "a", "a1"]);
    expect(flattenTree(tree(), new Set(), "nope")).toEqual([]);
  });
});

describe("expandableSubtreeIds", () => {
  test("lists the node and descendants that have children", () => {
    expect(expandableSubtreeIds(tree()[0]!)).toEqual(["w", "a", "b"]);
    expect(expandableSubtreeIds(node("leaf"))).toEqual([]);
  });
});

describe("treeKeyAction", () => {
  const rows = flattenTree(tree(), new Set(["b"]));
  test("Up/Down/Home/End move through visible rows", () => {
    expect(treeKeyAction(rows, "a", "ArrowDown")).toEqual({ select: "a1" });
    expect(treeKeyAction(rows, "a", "ArrowUp")).toEqual({ select: "w" });
    expect(treeKeyAction(rows, "w", "ArrowUp")).toBeNull();
    expect(treeKeyAction(rows, "b", "ArrowDown")).toBeNull();
    expect(treeKeyAction(rows, "a2", "Home")).toEqual({ select: "w" });
    expect(treeKeyAction(rows, "a2", "End")).toEqual({ select: "b" });
  });
  test("with no selection, selects the first or last row", () => {
    expect(treeKeyAction(rows, null, "ArrowDown")).toEqual({ select: "w" });
    expect(treeKeyAction(rows, "gone", "End")).toEqual({ select: "b" });
    expect(treeKeyAction([], null, "ArrowDown")).toBeNull();
  });
  test("Left collapses, then goes to the parent", () => {
    expect(treeKeyAction(rows, "a", "ArrowLeft")).toEqual({ collapse: "a" });
    expect(treeKeyAction(rows, "a1", "ArrowLeft")).toEqual({ select: "a" });
    expect(treeKeyAction(rows, "b", "ArrowLeft")).toEqual({ select: "w" });
    expect(treeKeyAction(flattenTree(tree(), new Set(["w"])), "w", "ArrowLeft")).toBeNull();
  });
  test("Right expands, then goes to the first child", () => {
    expect(treeKeyAction(rows, "b", "ArrowRight")).toEqual({ expand: "b" });
    expect(treeKeyAction(rows, "a", "ArrowRight")).toEqual({ select: "a1" });
    expect(treeKeyAction(rows, "a1", "ArrowRight")).toBeNull();
  });
});

describe("initialCollapsed", () => {
  test("keeps the top levels and single-child chains open", () => {
    const deep = [node("w", [node("chain", [node("x", [node("x1"), node("x2", [node("x2a")])]), node("y", [node("y1")])])])];
    expect([...initialCollapsed(deep, 2)]).toEqual(["x"]);
    // Deeper multi-child nodes are collapsed too, so revealing one path stays tidy.
    expect([...initialCollapsed(deep, 1)].sort()).toEqual(["chain", "x"]);
    expect([...initialCollapsed(tree(), 1)].sort()).toEqual(["a"]);
  });
});
