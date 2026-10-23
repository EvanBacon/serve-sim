// Depth layout for the experimental 3D hierarchy inspector: flattens a
// capture into draw-ordered layers and assigns each one an exploded depth.
import type { HierarchyNode, HierarchyRect } from "./model";

export type DepthMode = "overlap" | "tree";

export interface LayoutOptions {
  /**
   * "overlap" (Xcode-style, default): a view sits one level above the highest
   * view drawn before it that it overlaps, so non-overlapping siblings share a
   * plane and the stack stays shallow. "tree": level = depth in the tree.
   */
  mode?: DepthMode;
  /** Include hidden / alpha 0 views (and their subtrees). Default false. */
  showHidden?: boolean;
  /** Clip each view to its clipsToBounds ancestors. Default true. */
  clip?: boolean;
  /**
   * Views for which this returns false (transparent containers with nothing
   * of their own to draw) don't take a layer: they sit on their parent's
   * plane and don't push overlapping views up. UIKit wraps content in many
   * such views, so this keeps the exploded stack readable. Default: every
   * view has content.
   */
  hasContent?: (node: HierarchyNode) => boolean;
}

interface LayoutItem {
  node: HierarchyNode;
  /** Index of the parent item in `items`, or -1 for windows. */
  parent: number;
  treeDepth: number;
  level: number;
  /** Level children stack on: `level` for content views, the parent's for empty ones. */
  stackLevel: number;
  /** Portion of the frame left after ancestor clipping (null if fully clipped). */
  visibleRect: HierarchyRect | null;
  /** Visible part of the node's own snapshot, with its texture sub-rect. */
  snapshotRect: HierarchyRect | null;
  /** Normalized [u0, v0, u1, v1] of `snapshotRect` inside the snapshot image. */
  snapshotUv: [number, number, number, number] | null;
  /** True when the node or an ancestor is hidden / fully transparent. */
  hiddenInApp: boolean;
}

export interface Layout {
  items: LayoutItem[];
  maxLevel: number;
  /** Item index by node id. */
  indexById: Map<string, number>;
}

/** @lintignore exported for tests */
export function intersectRects(a: HierarchyRect, b: HierarchyRect): HierarchyRect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function hasArea(r: HierarchyRect | null): r is HierarchyRect {
  return r !== null && r.width > 0 && r.height > 0;
}

/** Texture coordinates of `sub` within `full` (v grows downward, like the image). */
export function subRectUv(full: HierarchyRect, sub: HierarchyRect): [number, number, number, number] {
  const u0 = (sub.x - full.x) / full.width;
  const v0 = (sub.y - full.y) / full.height;
  const u1 = (sub.x + sub.width - full.x) / full.width;
  const v1 = (sub.y + sub.height - full.y) / full.height;
  const c = (n: number) => Math.min(1, Math.max(0, n));
  return [c(u0), c(v0), c(u1), c(v1)];
}

/** Items in draw order (pre-order, subviews back to front) with depth levels. */
export function layoutHierarchy(windows: HierarchyNode[], options: LayoutOptions = {}): Layout {
  const mode = options.mode ?? "overlap";
  const showHidden = options.showHidden ?? false;
  const clip = options.clip ?? true;
  const hasContent = options.hasContent ?? (() => true);
  const items: LayoutItem[] = [];
  const indexById = new Map<string, number>();
  const obstacles: number[] = [];
  let maxLevel = 0;

  const visit = (node: HierarchyNode, parent: number, treeDepth: number, ancestorClip: HierarchyRect | null, hiddenAbove: boolean) => {
    const hiddenInApp = hiddenAbove || node.hidden || node.alpha <= 0.01;
    if (hiddenInApp && !showHidden) return;
    const visibleRect = clip && ancestorClip ? intersectRects(node.frame, ancestorClip) : node.frame;

    let snapshotRect: HierarchyRect | null = null;
    let snapshotUv: LayoutItem["snapshotUv"] = null;
    if (node.snapshot) {
      const full = node.snapshot.frame;
      const visible = clip && ancestorClip ? intersectRects(full, ancestorClip) : full;
      if (hasArea(visible)) {
        snapshotRect = visible;
        snapshotUv = subRectUv(full, visible);
      }
    }

    const content = hasContent(node);
    const parentStack = parent === -1 ? -1 : items[parent]!.stackLevel;
    let level: number;
    let stackLevel: number;
    if (mode === "tree") {
      level = treeDepth;
      stackLevel = treeDepth;
    } else if (!content) {
      level = Math.max(0, parentStack);
      stackLevel = parentStack;
    } else {
      // Ancestors overlap trivially but never exceed the parent's stack
      // level, so they need no special casing. Only views with content are
      // obstacles.
      level = parentStack + 1;
      const own = hasArea(visibleRect) ? visibleRect : null;
      if (own) {
        for (let i = 0; i < obstacles.length; i++) {
          const other = items[obstacles[i]!]!;
          if (other.level + 1 <= level) continue;
          if (intersectRects(own, other.visibleRect!)) level = other.level + 1;
        }
      }
      stackLevel = level;
    }
    if (level > maxLevel) maxLevel = level;

    const index = items.length;
    if (mode !== "tree" && content && hasArea(visibleRect)) obstacles.push(index);
    items.push({ node, parent, treeDepth, level, stackLevel, visibleRect: hasArea(visibleRect) ? visibleRect : null, snapshotRect, snapshotUv, hiddenInApp });
    indexById.set(node.id, index);

    const childClip = node.clipsToBounds
      ? (ancestorClip ? intersectRects(node.frame, ancestorClip) ?? { ...node.frame, width: 0, height: 0 } : node.frame)
      : ancestorClip;
    for (const child of node.children) visit(child, index, treeDepth + 1, childClip, hiddenInApp);
  };

  for (const window of windows) visit(window, -1, 0, null, false);
  return { items, maxLevel, indexById };
}

/** Ids from the root down to (and including) `id`, for expanding the tree list. */
export function ancestorIds(layout: Layout, id: string): string[] {
  const out: string[] = [];
  let index = layout.indexById.get(id);
  while (index !== undefined && index !== -1) {
    const item = layout.items[index]!;
    out.unshift(item.node.id);
    index = item.parent;
  }
  return out;
}
