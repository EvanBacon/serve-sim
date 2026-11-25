/**
 * Procedural device model for the 3D view: proportions come from the DeviceKit
 * 2D chrome metrics (body, screen, corner radii, button frames), so one path
 * covers every current iPhone / iPad without shipping a 3D asset.
 *
 * Object space: x right, y up, z toward the viewer; the front glass sits at
 * z = +depth/2. Units are normalized so the device body is 1 tall.
 */
import type { DeviceKitChromeDescriptor } from "../utils/grid";

export type DeviceKind = "phone" | "tablet";

export interface DeviceButtonBox {
  /** Center in object space. */
  x: number;
  y: number;
  z: number;
  /** Full extents along x, y, z. */
  sx: number;
  sy: number;
  sz: number;
}

export interface Device3DModel {
  kind: DeviceKind;
  width: number;
  height: number;
  depth: number;
  cornerRadius: number;
  /** Radius of the rounded transition between the flat sides and the faces. */
  edgeRadius: number;
  screen: {
    /** Center in object space. */
    x: number;
    y: number;
    halfWidth: number;
    halfHeight: number;
    radius: number;
  };
  buttons: DeviceButtonBox[];
}

export type DeviceKitChromeMetrics = Pick<
  DeviceKitChromeDescriptor,
  "body" | "screen" | "outerCornerRadius" | "innerCornerRadius" | "screenRadius"
> & {
  identifier?: string;
  buttons?: Pick<DeviceKitChromeDescriptor["buttons"][number], "frame">[];
};

/** Thickness / body width for current hardware (iPhone ~8.75 mm / 72 mm, iPad ~5.1 mm / 215 mm). */
const DEPTH_RATIO: Record<DeviceKind, number> = { phone: 0.118, tablet: 0.0245 };

export function deviceKindFor(
  deviceType: string | null | undefined,
  size: { width: number; height: number },
  chromeIdentifier?: string | null,
): DeviceKind {
  // DeviceKit chrome ids say it outright ("phone11", "tablet5").
  if (chromeIdentifier?.startsWith("tablet")) return "tablet";
  if (chromeIdentifier?.startsWith("phone")) return "phone";
  if (deviceType === "ipad") return "tablet";
  if (deviceType === "iphone") return "phone";
  const long = Math.max(size.width, size.height);
  const short = Math.min(size.width, size.height) || 1;
  return long / short < 1.6 ? "tablet" : "phone";
}

/**
 * Build the model from chrome metrics, or — when the device has no DeviceKit
 * chrome — a plain rounded slab around the screen size.
 */
export function device3DModel(
  chrome: DeviceKitChromeMetrics | null | undefined,
  screenSize: { width: number; height: number },
  kind: DeviceKind,
): Device3DModel {
  if (chrome && chrome.body.width > 0 && chrome.body.height > 0 && chrome.screen.width > 0) {
    return modelFromChrome(chrome, kind);
  }
  return fallbackModel(screenSize, kind);
}

function modelFromChrome(chrome: DeviceKitChromeMetrics, kind: DeviceKind): Device3DModel {
  const { body, screen } = chrome;
  // The chrome is authored portrait; a landscape-only body would be unusual
  // but keep the long axis vertical so roll does the turning.
  const s = 1 / body.height;
  const width = body.width * s;
  const height = 1;
  const depth = body.width * DEPTH_RATIO[kind] * s;
  const cornerRadius = Math.min(chrome.outerCornerRadius * s, width / 2, height / 2);
  const bodyCx = body.x + body.width / 2;
  const bodyCy = body.y + body.height / 2;
  const screenRadius = (chrome.screenRadius || chrome.innerCornerRadius || 0) * s;
  const halfWidth = (screen.width / 2) * s;
  const halfHeight = (screen.height / 2) * s;
  return {
    kind,
    width,
    height,
    depth,
    cornerRadius,
    edgeRadius: edgeRadiusFor(depth, cornerRadius),
    screen: {
      x: (screen.x + screen.width / 2 - bodyCx) * s,
      y: -(screen.y + screen.height / 2 - bodyCy) * s,
      halfWidth,
      halfHeight,
      radius: Math.min(screenRadius, halfWidth, halfHeight),
    },
    buttons: buttonBoxes(chrome, depth, s),
  };
}

function fallbackModel(screenSize: { width: number; height: number }, kind: DeviceKind): Device3DModel {
  const sw = Math.max(1, Math.min(screenSize.width, screenSize.height));
  const sh = Math.max(1, Math.max(screenSize.width, screenSize.height));
  const bezel = sw * (kind === "tablet" ? 0.045 : 0.042);
  const bodyW = sw + bezel * 2;
  const bodyH = sh + bezel * 2;
  const s = 1 / bodyH;
  const width = bodyW * s;
  const depth = bodyW * DEPTH_RATIO[kind] * s;
  const cornerRadius = width * (kind === "tablet" ? 0.067 : 0.18);
  const halfWidth = (sw / 2) * s;
  const halfHeight = (sh / 2) * s;
  return {
    kind,
    width,
    height: 1,
    depth,
    cornerRadius,
    edgeRadius: edgeRadiusFor(depth, cornerRadius),
    screen: {
      x: 0,
      y: 0,
      halfWidth,
      halfHeight,
      radius: Math.max(0, Math.min(cornerRadius - bezel * s, halfWidth, halfHeight)),
    },
    buttons: [],
  };
}

function edgeRadiusFor(depth: number, cornerRadius: number): number {
  return Math.min(depth * 0.36, cornerRadius * 0.9);
}

/** Button overhang past the body edge, in chrome points (kept visible at small sizes). */
const BUTTON_MIN_OUT = 2.5;
const BUTTON_MAX_OUT = 6;

/** Side buttons sit on the body edge, poking out by the chrome's overhang. */
function buttonBoxes(chrome: DeviceKitChromeMetrics, depth: number, s: number): DeviceButtonBox[] {
  const { body } = chrome;
  const left = body.x;
  const right = body.x + body.width;
  const top = body.y;
  const bottom = body.y + body.height;
  const bodyCx = body.x + body.width / 2;
  const bodyCy = body.y + body.height / 2;
  const boxes: DeviceButtonBox[] = [];
  for (const { frame } of chrome.buttons ?? []) {
    if (frame.width <= 0 || frame.height <= 0) continue;
    const cx = frame.x + frame.width / 2;
    const cy = frame.y + frame.height / 2;
    const thickness = depth * 0.5;
    // DeviceKit button frames straddle the body edge (their center is often
    // just inside it), so classify by the long axis and the nearest edge, and
    // keep only frames that actually reach that edge.
    if (frame.height >= frame.width) {
      const onLeft = Math.abs(cx - left) <= Math.abs(cx - right);
      const edge = onLeft ? left : right;
      if (Math.abs(cx - edge) > Math.max(frame.width, 4)) continue;
      const out = clamp(onLeft ? edge - frame.x : frame.x + frame.width - edge, BUTTON_MIN_OUT, BUTTON_MAX_OUT) * s;
      boxes.push({
        x: (edge - bodyCx) * s + (onLeft ? -out / 2 : out / 2),
        y: -(cy - bodyCy) * s,
        z: 0,
        sx: out * 2,
        sy: frame.height * s,
        sz: thickness,
      });
    } else {
      const onTop = Math.abs(cy - top) <= Math.abs(cy - bottom);
      const edge = onTop ? top : bottom;
      if (Math.abs(cy - edge) > Math.max(frame.height, 4)) continue;
      const out = clamp(onTop ? edge - frame.y : frame.y + frame.height - edge, BUTTON_MIN_OUT, BUTTON_MAX_OUT) * s;
      boxes.push({
        x: (cx - bodyCx) * s,
        y: -(edge - bodyCy) * s + (onTop ? out / 2 : -out / 2),
        z: 0,
        sx: frame.width * s,
        sy: out * 2,
        sz: thickness,
      });
    }
  }
  return boxes;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ─── Mesh ──────────────────────────────────────────────────────────────────

/** Material ids baked into the vertex stream. */
export const MAT_FRAME = 0;
export const MAT_FRONT = 1;
export const MAT_BACK = 2;
/** Side buttons: the frame's metal, polished a touch brighter so they read against the band. */
export const MAT_BUTTON = 3;

export interface Mesh {
  /** Interleaved [px, py, pz, nx, ny, nz, material] per vertex. */
  vertices: Float32Array;
  indices: Uint16Array;
}

const STRIDE = 7;

class MeshBuilder {
  v: number[] = [];
  i: number[] = [];
  get count() { return this.v.length / STRIDE; }
  vertex(p: readonly number[], n: readonly number[], m: number): number {
    this.v.push(p[0]!, p[1]!, p[2]!, n[0]!, n[1]!, n[2]!, m);
    return this.count - 1;
  }
  build(): Mesh {
    return { vertices: new Float32Array(this.v), indices: new Uint16Array(this.i) };
  }
}

/** Rounded-rectangle outline (CCW, outward normals), `segments` per corner. */
export function roundedRectOutline(
  width: number,
  height: number,
  radius: number,
  segments: number,
): { p: [number, number]; n: [number, number] }[] {
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.max(0, Math.min(radius, hw, hh));
  const corners: [number, number, number][] = [
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI],
    [hw - r, -hh + r, (3 * Math.PI) / 2],
  ];
  const out: { p: [number, number]; n: [number, number] }[] = [];
  for (const [cx, cy, start] of corners) {
    for (let k = 0; k <= segments; k++) {
      const a = start + (k / segments) * (Math.PI / 2);
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      out.push({ p: [cx + nx * r, cy + ny * r], n: [nx, ny] });
    }
  }
  return out;
}

/**
 * Extrude a rounded rectangle into a slab with rounded edges, appending to
 * `mesh`. `transform` maps object-space points (and normals) into place.
 */
function addSlab(
  mesh: MeshBuilder,
  opts: {
    width: number;
    height: number;
    depth: number;
    radius: number;
    edgeRadius: number;
    cornerSegments: number;
    edgeSegments: number;
    front: number;
    side: number;
    back: number;
    transform?: (p: [number, number, number]) => [number, number, number];
    transformNormal?: (n: [number, number, number]) => [number, number, number];
  },
) {
  const T = opts.transform ?? ((p) => p);
  const TN = opts.transformNormal ?? ((n) => n);
  const outline = roundedRectOutline(opts.width, opts.height, opts.radius, opts.cornerSegments);
  const hd = opts.depth / 2;
  const er = Math.min(opts.edgeRadius, hd, Math.max(0, opts.radius));
  // Profile from the front face edge to the back face edge: (inset, z, nOut, nZ).
  const profile: [number, number, number, number][] = [];
  for (let k = 0; k <= opts.edgeSegments; k++) {
    const t = (k / opts.edgeSegments) * (Math.PI / 2);
    profile.push([er * (1 - Math.sin(t)), hd - er * (1 - Math.cos(t)), Math.sin(t), Math.cos(t)]);
  }
  for (let k = 0; k <= opts.edgeSegments; k++) {
    const t = (k / opts.edgeSegments) * (Math.PI / 2);
    profile.push([er * (1 - Math.cos(t)), -hd + er * (1 - Math.sin(t)), Math.cos(t), -Math.sin(t)]);
  }
  const ring = outline.length;
  const base = mesh.count;
  for (const { p, n } of outline) {
    for (const [inset, z, no, nz] of profile) {
      mesh.vertex(T([p[0] - n[0] * inset, p[1] - n[1] * inset, z]), TN([n[0] * no, n[1] * no, nz]), opts.side);
    }
  }
  const rows = profile.length;
  for (let a = 0; a < ring; a++) {
    const b = (a + 1) % ring;
    for (let j = 0; j < rows - 1; j++) {
      const a0 = base + a * rows + j;
      const a1 = a0 + 1;
      const b0 = base + b * rows + j;
      const b1 = b0 + 1;
      mesh.i.push(a0, a1, b0, b0, a1, b1);
    }
  }
  // Caps: fans over the outline inset by the edge radius.
  for (const [z, nz, mat] of [[hd, 1, opts.front], [-hd, -1, opts.back]] as const) {
    const center = mesh.vertex(T([0, 0, z]), TN([0, 0, nz]), mat);
    const first = mesh.count;
    for (const { p, n } of outline) {
      mesh.vertex(T([p[0] - n[0] * er, p[1] - n[1] * er, z]), TN([0, 0, nz]), mat);
    }
    for (let a = 0; a < ring; a++) {
      const b = (a + 1) % ring;
      if (nz > 0) mesh.i.push(center, first + a, first + b);
      else mesh.i.push(center, first + b, first + a);
    }
  }
}

export function buildDeviceMesh(model: Device3DModel): Mesh {
  const mesh = new MeshBuilder();
  addSlab(mesh, {
    width: model.width,
    height: model.height,
    depth: model.depth,
    radius: model.cornerRadius,
    edgeRadius: model.edgeRadius,
    cornerSegments: 14,
    edgeSegments: 6,
    front: MAT_FRONT,
    side: MAT_FRAME,
    back: MAT_BACK,
  });
  for (const b of model.buttons) {
    // Build the cap facing +z (its rounded face), then turn it onto its side.
    const sideways = b.sx < b.sy; // left/right edge: long axis vertical
    const w = sideways ? b.sz : b.sx;
    const h = sideways ? b.sy : b.sz;
    const d = sideways ? b.sx : b.sy;
    const r = Math.min(w, h) / 2;
    const transform = sideways
      ? (p: [number, number, number]): [number, number, number] => [p[2] + b.x, p[1] + b.y, -p[0] + b.z]
      : (p: [number, number, number]): [number, number, number] => [p[0] + b.x, p[2] + b.y, -p[1] + b.z];
    const transformNormal = sideways
      ? (n: [number, number, number]): [number, number, number] => [n[2], n[1], -n[0]]
      : (n: [number, number, number]): [number, number, number] => [n[0], n[2], -n[1]];
    addSlab(mesh, {
      width: w,
      height: h,
      depth: d,
      radius: r,
      edgeRadius: Math.min(d * 0.3, r),
      cornerSegments: 5,
      edgeSegments: 2,
      front: MAT_BUTTON,
      side: MAT_BUTTON,
      back: MAT_BUTTON,
      transform,
      transformNormal,
    });
  }
  return mesh.build();
}
