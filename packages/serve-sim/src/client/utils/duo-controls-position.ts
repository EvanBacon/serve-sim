import type { DuoProjection } from "../../duo-renderer";

/** Resolution changes must not count as model animation. */
export function duoPoseKey(projection: DuoProjection | null) {
  return JSON.stringify(projection && [projection.panel, projection.hingeDegrees, projection.pieces]);
}

/** Follow physical edges in raw-screen corner order, never viewport bounds. */
export function duoHardwarePositions(projection: DuoProjection | null) {
  if (!projection) return [];
  const inner = projection.panel === "inner";
  const piece = projection.pieces[inner ? 1 : 0];
  if (!piece || piece.length < 4 || piece.slice(0, 4).some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)))) return [];
  const topLeft = piece[inner ? 3 : 0]!;
  const topRight = piece[inner ? 0 : 1]!;
  const bottomRight = piece[inner ? 1 : 2]!;
  const anchor = (key: number, a: number[], b: number[], fraction: number) => ({
    key,
    x: a[0]! + (b[0]! - a[0]!) * fraction,
    y: a[1]! + (b[1]! - a[1]!) * fraction,
    // Clockwise perimeter order puts the exterior on the edge's left side.
    angle: Math.atan2((b[1]! - a[1]!) * projection.height, (b[0]! - a[0]!) * projection.width) * 180 / Math.PI,
  });
  return [
    anchor(0, topLeft, topRight, 0.44),
    anchor(1, topLeft, topRight, 0.62),
    anchor(2, topRight, bottomRight, 0.3),
    anchor(3, topRight, bottomRight, 0.72),
  ];
}
