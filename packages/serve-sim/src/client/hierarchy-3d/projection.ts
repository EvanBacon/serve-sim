// Minimal column-major 4x4 math + orbit camera + picking for the experimental
// 3D hierarchy view. Kept dependency-free (no three.js) so the lazily served
// page stays small.

export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

function perspective(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Clip-space [x, y, z, w] of a world point. */
function transform(m: Mat4, p: Vec3): [number, number, number, number] {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  ];
}

export interface OrbitCamera {
  /** Degrees around the vertical axis; 0 looks at the screen head-on. */
  yaw: number;
  /** Degrees above (+) / below (−) the screen plane. */
  pitch: number;
  distance: number;
  /** World-space point the camera orbits. */
  target: Vec3;
}

export function cameraEye(cam: OrbitCamera): Vec3 {
  const yaw = (cam.yaw * Math.PI) / 180;
  const pitch = (cam.pitch * Math.PI) / 180;
  return [
    cam.target[0] + cam.distance * Math.cos(pitch) * Math.sin(yaw),
    cam.target[1] + cam.distance * Math.sin(pitch),
    cam.target[2] + cam.distance * Math.cos(pitch) * Math.cos(yaw),
  ];
}

export function viewProjection(cam: OrbitCamera, aspect: number, fovYDeg = 35): Mat4 {
  const eye = cameraEye(cam);
  const near = Math.max(1, cam.distance / 100);
  const far = cam.distance * 20 + 10_000;
  return multiply(perspective((fovYDeg * Math.PI) / 180, aspect, near, far), lookAt(eye, cam.target, [0, 1, 0]));
}

/** Distance that fits a `width`×`height` plane head-on in the viewport. */
export function fitDistance(width: number, height: number, aspect: number, fovYDeg = 35, margin = 1.15): number {
  const half = Math.tan(((fovYDeg * Math.PI) / 180) / 2);
  const byHeight = (height / 2) / half;
  const byWidth = (width / 2) / (half * aspect);
  return Math.max(byHeight, byWidth) * margin;
}

/** Move the orbit target in the camera's screen plane by a pixel delta. */
export function panTarget(cam: OrbitCamera, dxPx: number, dyPx: number, viewportHeightPx: number, fovYDeg = 35): Vec3 {
  const eye = cameraEye(cam);
  const forward = normalize(sub(cam.target, eye));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const worldPerPx = (2 * cam.distance * Math.tan(((fovYDeg * Math.PI) / 180) / 2)) / Math.max(1, viewportHeightPx);
  const mx = -dxPx * worldPerPx;
  const my = dyPx * worldPerPx;
  return [
    cam.target[0] + right[0] * mx + up[0] * my,
    cam.target[1] + right[1] * mx + up[1] * my,
    cam.target[2] + right[2] * mx + up[2] * my,
  ];
}

/**
 * Viewport pixel position of a world point, or null if behind the camera.
 * @lintignore exported for tests
 */
export function projectToScreen(m: Mat4, p: Vec3, width: number, height: number): { x: number; y: number; w: number } | null {
  const [cx, cy, , cw] = transform(m, p);
  if (cw <= 1e-6) return null;
  return { x: ((cx / cw + 1) / 2) * width, y: ((1 - cy / cw) / 2) * height, w: cw };
}

/**
 * Point-in-convex-polygon (either winding).
 * @lintignore exported for tests
 */
export function pointInConvexQuad(px: number, py: number, quad: Array<{ x: number; y: number }>): boolean {
  let sign = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % quad.length]!;
    const c = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

export interface PickPlane {
  /** Rect in world x/y (already centered and y-flipped). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z: number;
}

/**
 * Index of the plane under the pointer that is closest to the camera, or -1.
 * All planes are parallel (constant z), so along the pointer ray the nearest
 * one is simply the one whose z is closest to the eye's — unlike the depth of
 * a plane's centre, which misorders a big plane behind a small one at an
 * angle. Ties (same z) go to the later plane, which is drawn on top.
 */
export function pickPlane(m: Mat4, eyeZ: number, planes: Array<PickPlane | null>, px: number, py: number, width: number, height: number): number {
  let best = -1;
  let bestDistance = Infinity;
  const corners: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    if (!p) continue;
    const distance = Math.abs(eyeZ - p.z);
    if (distance > bestDistance + 1e-6) continue;
    corners.length = 0;
    for (const [x, y] of [[p.x0, p.y0], [p.x1, p.y0], [p.x1, p.y1], [p.x0, p.y1]] as const) {
      const c = projectToScreen(m, [x, y, p.z], width, height);
      if (!c) break;
      corners.push(c);
    }
    if (corners.length !== 4 || !pointInConvexQuad(px, py, corners)) continue;
    best = i;
    bestDistance = distance;
  }
  return best;
}
