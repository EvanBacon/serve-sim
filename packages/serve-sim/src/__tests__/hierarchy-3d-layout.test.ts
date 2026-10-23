import { describe, expect, test } from "bun:test";
import { ancestorIds, intersectRects, layoutHierarchy, subRectUv } from "../hierarchy-3d/layout";
import type { HierarchyNode } from "../hierarchy-3d/model";

function node(id: string, frame: [number, number, number, number], children: HierarchyNode[] = [], extra: Partial<HierarchyNode> = {}): HierarchyNode {
  const [x, y, width, height] = frame;
  return {
    id,
    class: "UIView",
    superclasses: [],
    frame: { x, y, width, height },
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

const levels = (windows: HierarchyNode[], opts = {}) =>
  Object.fromEntries(layoutHierarchy(windows, opts).items.map((i) => [i.node.id, i.level]));

describe("intersectRects", () => {
  test("returns the overlap or null", () => {
    expect(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 })).toBeNull();
  });
});

describe("subRectUv", () => {
  test("maps a sub-rect to normalized texture coordinates", () => {
    expect(subRectUv({ x: 10, y: 20, width: 100, height: 50 }, { x: 35, y: 20, width: 50, height: 25 })).toEqual([0.25, 0, 0.75, 0.5]);
  });
});

describe("layoutHierarchy", () => {
  // window
  // ├─ a (left half)
  // │  └─ a1
  // └─ b (right half)          ← doesn't overlap a, shares its plane
  //    └─ b1 (spills into a)   ← overlaps a1, must sit above it
  const tree = () => [
    node("win", [0, 0, 100, 100], [
      node("a", [0, 0, 50, 100], [node("a1", [10, 10, 30, 30])]),
      node("b", [50, 0, 50, 100], [node("b1", [30, 10, 40, 10])]),
    ]),
  ];

  test("emits items in draw order with parent links", () => {
    const { items } = layoutHierarchy(tree());
    expect(items.map((i) => i.node.id)).toEqual(["win", "a", "a1", "b", "b1"]);
    expect(items.map((i) => i.parent)).toEqual([-1, 0, 1, 0, 3]);
    expect(items.map((i) => i.treeDepth)).toEqual([0, 1, 2, 1, 2]);
  });

  test("overlap mode packs non-overlapping siblings and lifts overlapping views", () => {
    expect(levels(tree())).toEqual({ win: 0, a: 1, a1: 2, b: 1, b1: 3 });
    expect(layoutHierarchy(tree()).maxLevel).toBe(3);
  });

  test("tree mode uses tree depth", () => {
    expect(levels(tree(), { mode: "tree" })).toEqual({ win: 0, a: 1, a1: 2, b: 1, b1: 2 });
  });

  test("later windows stack above earlier ones they overlap", () => {
    const windows = [node("w1", [0, 0, 100, 100], [node("c", [0, 0, 10, 10])]), node("w2", [0, 0, 100, 100])];
    expect(levels(windows)).toEqual({ w1: 0, c: 1, w2: 2 });
  });

  test("zero-size views don't push others up", () => {
    const windows = [node("w", [0, 0, 100, 100], [node("empty", [0, 0, 0, 0]), node("x", [0, 0, 10, 10])])];
    expect(levels(windows)).toEqual({ w: 0, empty: 1, x: 1 });
  });

  test("hidden and transparent subtrees are skipped unless showHidden", () => {
    const windows = [
      node("w", [0, 0, 100, 100], [
        node("h", [0, 0, 10, 10], [node("hc", [0, 0, 5, 5])], { hidden: true }),
        node("t", [20, 0, 10, 10], [], { alpha: 0 }),
        node("v", [40, 0, 10, 10]),
      ]),
    ];
    expect(layoutHierarchy(windows).items.map((i) => i.node.id)).toEqual(["w", "v"]);
    const all = layoutHierarchy(windows, { showHidden: true }).items;
    expect(all.map((i) => i.node.id)).toEqual(["w", "h", "hc", "t", "v"]);
    expect(all.map((i) => i.hiddenInApp)).toEqual([false, true, true, true, false]);
  });

  test("clipsToBounds ancestors clip visible rects and snapshot UVs", () => {
    const scroller = node("scroll", [0, 100, 100, 100], [
      node("row", [0, 150, 100, 100], [], {
        snapshot: { frame: { x: 0, y: 150, width: 100, height: 100 }, url: "/s" },
      }),
      node("offscreen", [0, 300, 100, 50]),
    ], { clipsToBounds: true });
    const { items } = layoutHierarchy([node("w", [0, 0, 100, 400], [scroller])]);
    const row = items.find((i) => i.node.id === "row")!;
    expect(row.visibleRect).toEqual({ x: 0, y: 150, width: 100, height: 50 });
    expect(row.snapshotRect).toEqual({ x: 0, y: 150, width: 100, height: 50 });
    expect(row.snapshotUv).toEqual([0, 0, 1, 0.5]);
    expect(items.find((i) => i.node.id === "offscreen")!.visibleRect).toBeNull();

    const unclipped = layoutHierarchy([node("w", [0, 0, 100, 400], [scroller])], { clip: false }).items;
    expect(unclipped.find((i) => i.node.id === "row")!.snapshotUv).toEqual([0, 0, 1, 1]);
    expect(unclipped.find((i) => i.node.id === "offscreen")!.visibleRect).toEqual({ x: 0, y: 300, width: 100, height: 50 });
  });

  test("fully clipped views don't affect the overlap stack", () => {
    const windows = [
      node("w", [0, 0, 100, 100], [
        node("clip", [0, 0, 50, 50], [node("gone", [60, 0, 30, 30])], { clipsToBounds: true }),
        node("right", [60, 0, 30, 30]),
      ]),
    ];
    expect(levels(windows)).toEqual({ w: 0, clip: 1, gone: 2, right: 1 });
  });

  test("hasContent: empty containers share their parent's plane and aren't obstacles", () => {
    const filled = { backgroundColor: [1, 1, 1, 1] as [number, number, number, number] };
    const windows = [
      node("win", [0, 0, 100, 100], [
        node("wrap1", [0, 0, 100, 100], [
          node("wrap2", [0, 0, 100, 100], [node("label", [10, 10, 50, 20], [], filled)]),
        ]),
        node("wrap3", [0, 0, 100, 100], [node("button", [10, 50, 50, 20], [], filled)]),
        node("badge", [20, 15, 10, 10], [], filled),
      ], filled),
    ];
    const hasContent = (n: HierarchyNode) => n.backgroundColor !== null;
    expect(levels(windows, { hasContent })).toEqual({ win: 0, wrap1: 0, wrap2: 0, label: 1, wrap3: 0, button: 1, badge: 2 });
    // Without the predicate every wrapper takes (and pushes) a layer.
    expect(levels(windows)).toEqual({ win: 0, wrap1: 1, wrap2: 2, label: 3, wrap3: 4, button: 5, badge: 5 });
  });

  test("ancestorIds walks up to the root", () => {
    const layout = layoutHierarchy(tree());
    expect(ancestorIds(layout, "b1")).toEqual(["win", "b", "b1"]);
    expect(ancestorIds(layout, "missing")).toEqual([]);
  });
});
