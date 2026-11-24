import type { StreamConfig } from "../types";
import {
  HID_EDGE_BOTTOM,
  homeIndicatorEdge,
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamDisplayGeometry,
} from "../simulator/orientation";

/**
 * Coordinate spaces for the 3D device view (all normalized 0..1, top-left
 * origin):
 *
 * - **screen uv**: the device's own (portrait-authored) screen, the way the
 *   glass is laid out on the 3D model. Stays put when the sim rotates — the
 *   whole model rolls instead.
 * - **display**: the upright picture the 2D viewer shows after it turns the
 *   device on the page (`DeviceRotor`) and the screen content back
 *   (`DeviceRotorScreen`).
 * - **raw**: the stream framebuffer — texture coordinates for the live frame
 *   and what `onStreamTouch` expects.
 *
 * Sampling the texture and hit-testing a click both go screen uv → display →
 * raw through the same functions, so what you see is what you tap.
 */
export interface ScreenUv {
  u: number;
  v: number;
}

/** Where a point on the device's portrait screen lands in the upright display. */
export function displayPointForScreenUv(
  { u, v }: ScreenUv,
  deviceDegrees: number,
): { x: number; y: number } {
  switch (normalizeQuarterTurn(deviceDegrees)) {
    case 90:
      return { x: 1 - v, y: u };
    case 180:
      return { x: 1 - u, y: 1 - v };
    case 270:
      return { x: v, y: 1 - u };
    default:
      return { x: u, y: v };
  }
}

/** Screen uv → raw framebuffer point (texture coordinate / touch payload). */
export function rawPointForScreenUv(
  uv: ScreenUv,
  deviceDegrees: number,
  streamConfig: Pick<StreamConfig, "width" | "height" | "orientation"> | null | undefined,
): { x: number; y: number } {
  const display = displayPointForScreenUv(uv, deviceDegrees);
  const orientation = streamDisplayGeometry(streamConfig).inputOrientation;
  return rawPointForDisplayPoint(orientation, display.x, display.y);
}

/**
 * The affine map screen uv → raw texture coordinate as a column-major 3x2
 * `[a, b, c, d, tx, ty]` (raw = [a c; b d]·uv + t). It is always a quarter
 * turn / flip, so three samples pin it exactly.
 */
export function screenUvToRawMatrix(
  deviceDegrees: number,
  streamConfig: Pick<StreamConfig, "width" | "height" | "orientation"> | null | undefined,
): [number, number, number, number, number, number] {
  const o = rawPointForScreenUv({ u: 0, v: 0 }, deviceDegrees, streamConfig);
  const x = rawPointForScreenUv({ u: 1, v: 0 }, deviceDegrees, streamConfig);
  const y = rawPointForScreenUv({ u: 0, v: 1 }, deviceDegrees, streamConfig);
  return [x.x - o.x, x.y - o.y, y.x - o.x, y.y - o.y, o.x, o.y];
}

export interface ScreenTouch {
  type: "begin" | "move" | "end";
  x: number;
  y: number;
  edge?: number;
}

/**
 * Build the `onStreamTouch` payload for a touch at `uv` on the 3D screen,
 * mirroring `SimulatorView`: a drag that starts in the home-indicator band of
 * the *display* is tagged with the bottom edge (remapped into raw space).
 */
export function screenTouchPayload(
  type: ScreenTouch["type"],
  uv: ScreenUv,
  deviceDegrees: number,
  streamConfig: Pick<StreamConfig, "width" | "height" | "orientation"> | null | undefined,
  edgeGesture: boolean,
): ScreenTouch {
  const clamped = { u: clamp01(uv.u), v: clamp01(uv.v) };
  const raw = rawPointForScreenUv(clamped, deviceDegrees, streamConfig);
  if (!edgeGesture) return { type, ...raw };
  const orientation = streamDisplayGeometry(streamConfig).inputOrientation;
  return { type, ...raw, edge: rawEdgeForDisplayEdge(orientation, HID_EDGE_BOTTOM) };
}

/** Whether a touch beginning at `uv` starts the swipe-home edge gesture. */
export function startsEdgeGesture(uv: ScreenUv, deviceDegrees: number): boolean {
  return homeIndicatorEdge(displayPointForScreenUv(uv, deviceDegrees).y) !== undefined;
}

function normalizeQuarterTurn(degrees: number): 0 | 90 | 180 | 270 {
  const q = ((Math.round(degrees / 90) % 4) + 4) % 4;
  return (q * 90) as 0 | 90 | 180 | 270;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
