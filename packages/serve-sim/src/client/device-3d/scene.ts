/**
 * Camera / pose math for the 3D device view. Pure (no DOM / WebGL) so the
 * projection and screen hit-test are unit-testable.
 *
 * Pose: the device rolls about its own z axis to follow the sim's orientation
 * (portrait / landscape), then turns about the world y axis (yaw, the user's
 * horizontal orbit). The camera orbits in elevation (pitch) around the device.
 * Lights and the ground stay fixed in the world, like a turntable in a studio.
 */
import type { Device3DModel } from "./model";

export type Mat4 = Float32Array;

export interface ViewState {
  /** Turntable angle, radians (positive turns the device's right side away). */
  yaw: number;
  /** Camera elevation, radians (positive looks down onto the device). */
  pitch: number;
  /** Device roll, radians (CSS-clockwise sim rotations are negative here). */
  roll: number;
}

export const DEFAULT_YAW = -0.38;
export const DEFAULT_PITCH = 0.12;
export const MIN_PITCH = -0.35;
export const MAX_PITCH = 1.1;
export const FOV_Y = (24 * Math.PI) / 180;

export function defaultView(roll = 0): ViewState {
  return { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, roll };
}

/** Roll (radians) for a sim rotation in CSS degrees (clockwise positive). */
export function rollForDeviceDegrees(deviceDegrees: number): number {
  return (-deviceDegrees * Math.PI) / 180;
}

export function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch));
}

// ─── mat4 (column-major, WebGL layout) ─────────────────────────────────────

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export function rotationY(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
  return m;
}

export function rotationZ(a: number): Mat4 {
  const m = identity();
  const c = Math.cos(a);
  const s = Math.sin(a);
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  return m;
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

export function lookAt(eye: number[], target: number[], up: number[]): Mat4 {
  const z = normalize([eye[0]! - target[0]!, eye[1]! - target[1]!, eye[2]! - target[2]!]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const m = identity();
  m[0] = x[0]!; m[4] = x[1]!; m[8] = x[2]!;
  m[1] = y[0]!; m[5] = y[1]!; m[9] = y[2]!;
  m[2] = z[0]!; m[6] = z[1]!; m[10] = z[2]!;
  m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye);
  return m;
}

export function transformPoint(m: Mat4, p: number[]): number[] {
  const x = p[0]!, y = p[1]!, z = p[2]!;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
  ];
}

function transformDir(m: Mat4, d: number[]): number[] {
  return [
    m[0]! * d[0]! + m[4]! * d[1]! + m[8]! * d[2]!,
    m[1]! * d[0]! + m[5]! * d[1]! + m[9]! * d[2]!,
    m[2]! * d[0]! + m[6]! * d[1]! + m[10]! * d[2]!,
  ];
}

export function cross(a: number[], b: number[]): number[] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

export function dot(a: number[], b: number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

export function normalize(v: number[]): number[] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

// ─── Scene ─────────────────────────────────────────────────────────────────

export interface SceneMatrices {
  /** Device pose: a pure rotation (no scale / translation). */
  model: Mat4;
  view: Mat4;
  projection: Mat4;
  eye: number[];
  /** World y of the ground the contact shadow lands on. */
  groundY: number;
  /** Lowest world y of the device body (for the shadow gap). */
  bottomY: number;
}

/** Visible height (in canvas fractions) reserved below the device for the shadow. */
const SHADOW_ROOM = 0.05;
/** World-space gap between the lowest point of the body and the contact-shadow plane. */
const SHADOW_GAP = 0.035;
const FIT_MARGIN = 1.03;
/** Covers near-edge perspective the view-space half-extents miss. */
const ORBIT_FIT = 1.05;

export function sceneMatrices(model: Device3DModel, view: ViewState, aspect: number): SceneMatrices {
  const rotation = multiply(rotationY(view.yaw), rotationZ(view.roll));
  const c = Math.abs(Math.cos(view.roll));
  const s = Math.abs(Math.sin(view.roll));
  const extentX = c * model.width + s * model.height;
  const extentY = s * model.width + c * model.height;
  const t = Math.tan(FOV_Y / 2);
  const safeAspect = aspect > 0 ? aspect : 1;
  // Bound the fit over every orbit yaw and pitch, not the live pose, so turning
  // the device never zooms. After roll, yaw swings the horizontal half-extent
  // and the thickness in xz (radius). Pitch then projects that depth onto the
  // vertical axis — which is how a landscape device end-on used to clip.
  const radius = Math.hypot(extentX / 2, model.depth / 2);
  const targetY = -extentY * SHADOW_ROOM * 0.5;
  const spanY = Math.max(Math.abs(extentY / 2 - targetY), Math.abs(-extentY / 2 - SHADOW_GAP - targetY));
  let viewY = 0;
  for (const pitch of [0, MIN_PITCH, MAX_PITCH]) {
    viewY = Math.max(viewY, Math.abs(Math.cos(pitch)) * spanY + Math.abs(Math.sin(pitch)) * radius);
  }
  const distance =
    Math.max(viewY * FIT_MARGIN / t, (radius * FIT_MARGIN) / (t * safeAspect)) * ORBIT_FIT;
  // Lowest point of the rotated body: sum of the half axes' downward reach.
  const ax = transformDir(rotation, [model.width / 2, 0, 0]);
  const ay = transformDir(rotation, [0, model.height / 2, 0]);
  const az = transformDir(rotation, [0, 0, model.depth / 2]);
  const bottomY = -(Math.abs(ax[1]!) + Math.abs(ay[1]!) + Math.abs(az[1]!));
  const groundY = bottomY - SHADOW_GAP;
  // Aim a touch low so the device floats with room for its shadow.
  const target = [0, -extentY * SHADOW_ROOM * 0.5, 0];
  const eye = [
    target[0]!,
    target[1]! + Math.sin(view.pitch) * distance,
    target[2]! + Math.cos(view.pitch) * distance,
  ];
  return {
    model: rotation,
    view: lookAt(eye, target, [0, 1, 0]),
    projection: perspective(FOV_Y, safeAspect, Math.max(0.01, distance * 0.1), distance * 4),
    eye,
    groundY,
    bottomY,
  };
}

export interface ScreenHit {
  /** Screen uv (portrait-authored, top-left origin); may fall outside 0..1. */
  u: number;
  v: number;
  /** Inside the rounded screen rectangle. */
  onScreen: boolean;
  /** Inside the device's front face outline. */
  onDevice: boolean;
}

/**
 * Cast a ray through normalized device coordinates (-1..1, y up) and hit the
 * front glass plane. Null when the ray misses it or sees it from behind.
 */
export function pickScreen(
  model: Device3DModel,
  scene: Pick<SceneMatrices, "model" | "eye" | "view" | "projection">,
  ndcX: number,
  ndcY: number,
): ScreenHit | null {
  const inv = invert(multiply(scene.projection, scene.view));
  if (!inv) return null;
  const near = transformPoint(inv, [ndcX, ndcY, -1]);
  const far = transformPoint(inv, [ndcX, ndcY, 1]);
  // Into object space: the model is a pure rotation, so its inverse is its transpose.
  const toObject = (v: number[]) => [
    scene.model[0]! * v[0]! + scene.model[1]! * v[1]! + scene.model[2]! * v[2]!,
    scene.model[4]! * v[0]! + scene.model[5]! * v[1]! + scene.model[6]! * v[2]!,
    scene.model[8]! * v[0]! + scene.model[9]! * v[1]! + scene.model[10]! * v[2]!,
  ];
  const origin = toObject(near);
  const dir = toObject([far[0]! - near[0]!, far[1]! - near[1]!, far[2]! - near[2]!]);
  if (dir[2]! >= 0) return null; // parallel, or looking at the back
  const planeZ = model.depth / 2;
  const t = (planeZ - origin[2]!) / dir[2]!;
  if (t < 0) return null;
  const x = origin[0]! + dir[0]! * t;
  const y = origin[1]! + dir[1]! * t;
  const sc = model.screen;
  return {
    u: (x - (sc.x - sc.halfWidth)) / (2 * sc.halfWidth),
    v: (sc.y + sc.halfHeight - y) / (2 * sc.halfHeight),
    onScreen: roundedRectSdf(x - sc.x, y - sc.y, sc.halfWidth, sc.halfHeight, sc.radius) <= 0,
    onDevice: roundedRectSdf(x, y, model.width / 2, model.height / 2, model.cornerRadius) <= 0,
  };
}

/** Where object-space point `p` lands in normalized device coordinates. */
export function projectToNdc(
  scene: Pick<SceneMatrices, "model" | "view" | "projection">,
  p: number[],
): { x: number; y: number } {
  const world = transformPoint(scene.model, p);
  const clip = transformPoint(multiply(scene.projection, scene.view), world);
  return { x: clip[0]!, y: clip[1]! };
}

export function roundedRectSdf(x: number, y: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x) - hw + r;
  const qy = Math.abs(y) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

export function invert(m: Mat4): Mat4 | null {
  const a = m;
  const o = new Float32Array(16);
  const b00 = a[0]! * a[5]! - a[1]! * a[4]!;
  const b01 = a[0]! * a[6]! - a[2]! * a[4]!;
  const b02 = a[0]! * a[7]! - a[3]! * a[4]!;
  const b03 = a[1]! * a[6]! - a[2]! * a[5]!;
  const b04 = a[1]! * a[7]! - a[3]! * a[5]!;
  const b05 = a[2]! * a[7]! - a[3]! * a[6]!;
  const b06 = a[8]! * a[13]! - a[9]! * a[12]!;
  const b07 = a[8]! * a[14]! - a[10]! * a[12]!;
  const b08 = a[8]! * a[15]! - a[11]! * a[12]!;
  const b09 = a[9]! * a[14]! - a[10]! * a[13]!;
  const b10 = a[9]! * a[15]! - a[11]! * a[13]!;
  const b11 = a[10]! * a[15]! - a[11]! * a[14]!;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  o[0] = (a[5]! * b11 - a[6]! * b10 + a[7]! * b09) * d;
  o[1] = (a[2]! * b10 - a[1]! * b11 - a[3]! * b09) * d;
  o[2] = (a[13]! * b05 - a[14]! * b04 + a[15]! * b03) * d;
  o[3] = (a[10]! * b04 - a[9]! * b05 - a[11]! * b03) * d;
  o[4] = (a[6]! * b08 - a[4]! * b11 - a[7]! * b07) * d;
  o[5] = (a[0]! * b11 - a[2]! * b08 + a[3]! * b07) * d;
  o[6] = (a[14]! * b02 - a[12]! * b05 - a[15]! * b01) * d;
  o[7] = (a[8]! * b05 - a[10]! * b02 + a[11]! * b01) * d;
  o[8] = (a[4]! * b10 - a[5]! * b08 + a[7]! * b06) * d;
  o[9] = (a[1]! * b08 - a[0]! * b10 - a[3]! * b06) * d;
  o[10] = (a[12]! * b04 - a[13]! * b02 + a[15]! * b00) * d;
  o[11] = (a[9]! * b02 - a[8]! * b04 - a[11]! * b00) * d;
  o[12] = (a[5]! * b07 - a[4]! * b09 - a[6]! * b06) * d;
  o[13] = (a[0]! * b09 - a[1]! * b07 + a[2]! * b06) * d;
  o[14] = (a[13]! * b01 - a[12]! * b03 - a[14]! * b00) * d;
  o[15] = (a[8]! * b03 - a[9]! * b01 + a[10]! * b00) * d;
  return o;
}

/** Shortest-way target for an angle tween (keeps |to - from| ≤ π). */
export function nearestAngle(from: number, to: number): number {
  const full = Math.PI * 2;
  let d = (to - from) % full;
  if (d > Math.PI) d -= full;
  if (d < -Math.PI) d += full;
  return from + d;
}
