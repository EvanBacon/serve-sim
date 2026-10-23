// Experimental 3D view-hierarchy inspector (`--experimental-hierarchy-3d`).
// Wire model shared by the server routes and the /hierarchy-3d page, plus the
// defensive normalizers for the two data sources: the injected
// SimHierarchyInjector agent and the accessibility-tree fallback.

export interface HierarchyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type HierarchyPropValue = string | number | boolean | number[];

export interface HierarchyNode {
  id: string;
  /** UIView class, or the AX element type for accessibility captures. */
  class: string;
  superclasses: string[];
  /** Bounding box in screen points (transforms are flattened). */
  frame: HierarchyRect;
  /** Frame in the superview's coordinate space, when known. */
  localFrame?: HierarchyRect;
  bounds?: HierarchyRect;
  alpha: number;
  hidden: boolean;
  clipsToBounds: boolean;
  /** sRGB components 0..1, or null when clear / not a plain color. */
  backgroundColor: [number, number, number, number] | null;
  /** Index among the parent's subviews (draw order, back to front). */
  zIndex: number;
  layerClass?: string;
  viewController?: string;
  accessibilityIdentifier?: string;
  accessibilityLabel?: string;
  props: Record<string, HierarchyPropValue>;
  /** This view's own pixels (subviews hidden), cropped to `frame`. */
  snapshot?: { frame: HierarchyRect; url: string };
  children: HierarchyNode[];
}

type HierarchySource = "injected" | "accessibility";

export interface HierarchyCapture {
  source: HierarchySource;
  captureId: string;
  bundleId: string | null;
  pid: number | null;
  screen: { width: number; height: number; scale?: number };
  nodeCount: number;
  truncated: boolean;
  durationMs?: number;
  /** Whole-screen PNG used to texture nodes that have no own snapshot. */
  screenshotUrl?: string;
  windows: HierarchyNode[];
}

/** What the page gets from `GET …/hierarchy-3d/api/capture`. */
export interface HierarchyCaptureResponse {
  capture: HierarchyCapture | null;
  /** Foreground app, when known (used to offer an inspector relaunch). */
  foreground: { bundleId: string; pid: number | null } | null;
  /** Why the richer injected source wasn't used, if it wasn't. */
  notice?: string;
  /** Whether this page may ask the server to relaunch the app with the agent. */
  canInject: boolean;
  error?: string;
}

const MAX_NODES = 5000;
const MAX_DEPTH = 300;
const MAX_STRING = 500;

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** @lintignore exported for tests */
export function normalizeRect(value: unknown): HierarchyRect | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const rect = { x: num(r.x, NaN), y: num(r.y, NaN), width: num(r.width, NaN), height: num(r.height, NaN) };
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  if (rect.width < 0 || rect.height < 0) return null;
  return rect;
}

function normalizeColor(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((c) => typeof c === "number" && Number.isFinite(c))) return null;
  const [r, g, b, a] = value.map((c: number) => Math.min(1, Math.max(0, c))) as [number, number, number, number];
  return [r, g, b, a];
}

function normalizeProps(value: unknown): Record<string, HierarchyPropValue> {
  const out: Record<string, HierarchyPropValue> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (count++ >= 64) break;
    if (typeof v === "string") out[key] = str(v) ?? "";
    else if (typeof v === "boolean") out[key] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (Array.isArray(v) && v.length <= 16 && v.every((n) => typeof n === "number" && Number.isFinite(n))) {
      out[key] = v as number[];
    }
  }
  return out;
}

/**
 * Validate the injected agent's `/hierarchy` JSON. Malformed nodes (no id or
 * frame) are dropped with their subtree; strings are length-capped and the
 * tree is capped in size and depth so a misbehaving app can't wedge the page.
 * `snapshotUrl` maps a view id to the server route that proxies its PNG.
 */
export function normalizeAgentCapture(
  raw: unknown,
  snapshotUrl: (captureId: string, viewId: string) => string,
): HierarchyCapture {
  if (!raw || typeof raw !== "object") throw new Error("Invalid hierarchy payload");
  const r = raw as Record<string, unknown>;
  const captureId = str(r.captureId, 64);
  if (!captureId || !/^[\w-]+$/.test(captureId)) throw new Error("Hierarchy payload is missing captureId");
  const screenRaw = (r.screen ?? {}) as Record<string, unknown>;
  const screen = {
    width: Math.max(1, num(screenRaw.width, 1)),
    height: Math.max(1, num(screenRaw.height, 1)),
    scale: num(screenRaw.scale, 1),
  };
  let count = 0;
  let truncated = r.truncated === true;

  const visit = (value: unknown, depth: number, index: number): HierarchyNode | null => {
    if (!value || typeof value !== "object") return null;
    if (count >= MAX_NODES || depth > MAX_DEPTH) {
      truncated = true;
      return null;
    }
    const n = value as Record<string, unknown>;
    const id = str(n.id, 64);
    const frame = normalizeRect(n.frame);
    if (!id || !frame) return null;
    count++;
    const node: HierarchyNode = {
      id,
      class: str(n.class, 200) ?? "UIView",
      superclasses: Array.isArray(n.superclasses)
        ? n.superclasses.filter((s): s is string => typeof s === "string").slice(0, 12).map((s) => str(s, 200)!)
        : [],
      frame,
      alpha: Math.min(1, Math.max(0, num(n.alpha, 1))),
      hidden: n.hidden === true,
      clipsToBounds: n.clipsToBounds === true,
      backgroundColor: normalizeColor(n.backgroundColor),
      zIndex: num(n.zIndex, index),
      props: normalizeProps(n.props),
      children: [],
    };
    const localFrame = normalizeRect(n.localFrame);
    if (localFrame) node.localFrame = localFrame;
    const bounds = normalizeRect(n.bounds);
    if (bounds) node.bounds = bounds;
    for (const key of ["layerClass", "viewController", "accessibilityIdentifier", "accessibilityLabel"] as const) {
      const v = str(n[key]);
      if (v) node[key] = v;
    }
    for (const key of ["opaque", "userInteractionEnabled"] as const) {
      if (typeof n[key] === "boolean") node.props[key] = n[key] as boolean;
    }
    if (typeof n.contentMode === "string") node.props.contentMode = str(n.contentMode, 40)!;
    if (typeof n.tag === "number" && n.tag !== 0) node.props.tag = n.tag;
    const snap = n.snapshot as Record<string, unknown> | undefined;
    const snapFrame = snap ? normalizeRect(snap.frame) : null;
    if (snapFrame && snapFrame.width > 0 && snapFrame.height > 0) {
      node.snapshot = { frame: snapFrame, url: snapshotUrl(captureId, id) };
    }
    if (Array.isArray(n.children)) {
      n.children.forEach((child, i) => {
        const c = visit(child, depth + 1, i);
        if (c) node.children.push(c);
      });
    }
    return node;
  };

  const windows: HierarchyNode[] = [];
  if (Array.isArray(r.windows)) {
    r.windows.forEach((w, i) => {
      const node = visit(w, 0, i);
      if (node) windows.push(node);
    });
  }
  const capture: HierarchyCapture = {
    source: "injected",
    captureId,
    bundleId: str(r.bundleId, 300) ?? null,
    pid: typeof r.pid === "number" ? r.pid : null,
    screen,
    nodeCount: count,
    truncated,
    windows,
  };
  if (typeof r.durationMs === "number") capture.durationMs = r.durationMs;
  return capture;
}

/** One node of the native AX bridge's `axDescribe` JSON (see src/ax.ts). */
interface RawAxNode {
  AXUniqueId?: string | null;
  AXLabel?: string | null;
  AXValue?: string | null;
  enabled?: boolean;
  frame?: unknown;
  role_description?: string;
  type?: string;
  children?: unknown[];
}

/**
 * Turn the accessibility tree into a capture. There are no classes, colors or
 * per-view pixels here: nodes are textured by cropping `screenshotUrl`.
 */
export function axTreeToCapture(
  raw: unknown,
  opts: { captureId: string; bundleId: string | null; pid: number | null; screenshotUrl?: string },
): HierarchyCapture {
  const roots = Array.isArray(raw) ? (raw as RawAxNode[]) : [];
  const rootFrame = normalizeRect(roots[0]?.frame);
  let count = 0;
  let truncated = false;

  const visit = (n: RawAxNode, path: string, depth: number, index: number): HierarchyNode | null => {
    if (!n || typeof n !== "object") return null;
    if (count >= MAX_NODES || depth > MAX_DEPTH) {
      truncated = true;
      return null;
    }
    const frame = normalizeRect(n.frame);
    if (!frame) return null;
    count++;
    const type = str(n.type, 100) ?? "Element";
    const props: Record<string, HierarchyPropValue> = { enabled: n.enabled !== false };
    const role = str(n.role_description, 100);
    if (role) props.role = role;
    const value = str(n.AXValue ?? undefined);
    if (value) props.value = value;
    const node: HierarchyNode = {
      id: `ax:${path}`,
      class: type,
      superclasses: [],
      frame,
      alpha: 1,
      hidden: false,
      clipsToBounds: false,
      backgroundColor: null,
      zIndex: index,
      props,
      children: [],
    };
    const label = str(n.AXLabel ?? undefined);
    if (label) node.accessibilityLabel = label;
    const uid = str(n.AXUniqueId ?? undefined);
    if (uid) node.accessibilityIdentifier = uid;
    (Array.isArray(n.children) ? n.children : []).forEach((child, i) => {
      const c = visit(child as RawAxNode, `${path}.${i}`, depth + 1, i);
      if (c) node.children.push(c);
    });
    return node;
  };

  const windows: HierarchyNode[] = [];
  roots.forEach((root, i) => {
    const node = visit(root, String(i), 0, i);
    if (node) windows.push(node);
  });
  const capture: HierarchyCapture = {
    source: "accessibility",
    captureId: opts.captureId,
    bundleId: opts.bundleId,
    pid: opts.pid,
    screen: {
      width: Math.max(1, rootFrame?.width ?? 1),
      height: Math.max(1, rootFrame?.height ?? 1),
    },
    nodeCount: count,
    truncated,
    windows,
  };
  if (opts.screenshotUrl) capture.screenshotUrl = opts.screenshotUrl;
  return capture;
}
