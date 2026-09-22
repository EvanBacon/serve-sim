import type { DuoProjection } from "../../duo-renderer";

/** Invert each perspective quad, then map into that leaf's raw framebuffer region. */
export function pointOnDuoScreen(projection: DuoProjection | null, x: number, y: number): { x: number; y: number } | null {
  if (!projection) return null;
  for (const piece of projection.pieces) {
    if (piece.length !== 5) continue;
    const [p0, p1, p2, p3, region] = piece as [number[], number[], number[], number[], number[]];
    if ([...p0, ...p1, ...p2, ...p3, ...region].some((n) => !Number.isFinite(n))) continue;
    const dx1 = p1[0]! - p2[0]!, dx2 = p3[0]! - p2[0]!;
    const dy1 = p1[1]! - p2[1]!, dy2 = p3[1]! - p2[1]!;
    const sx = p0[0]! - p1[0]! + p2[0]! - p3[0]!;
    const sy = p0[1]! - p1[1]! + p2[1]! - p3[1]!;
    const denominator = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(denominator) < 1e-10) continue;
    const g = (sx * dy2 - dx2 * sy) / denominator;
    const h = (dx1 * sy - sx * dy1) / denominator;
    const a = p1[0]! - p0[0]! + g * p1[0]!;
    const b = p3[0]! - p0[0]! + h * p3[0]!;
    const d = p1[1]! - p0[1]! + g * p1[1]!;
    const e = p3[1]! - p0[1]! + h * p3[1]!;
    const aa = a - x * g, bb = b - x * h, dd = d - y * g, ee = e - y * h;
    const determinant = aa * ee - bb * dd;
    if (Math.abs(determinant) < 1e-10) continue;
    const u = ((x - p0[0]!) * ee - bb * (y - p0[1]!)) / determinant;
    const v = (aa * (y - p0[1]!) - (x - p0[0]!) * dd) / determinant;
    if (u < -0.001 || v < -0.001 || u > 1.001 || v > 1.001) continue;
    return { x: region[0]! + Math.max(0, Math.min(1, u)) * region[2]!, y: region[1]! + Math.max(0, Math.min(1, v)) * region[3]! };
  }
  return null;
}

/** Clip a raw framebuffer rectangle at the hinge, then project each leaf. */
export function projectDuoRect(projection: DuoProjection, rect: { x: number; y: number; width: number; height: number }): number[][][] {
  return projection.pieces.flatMap((piece) => {
    if (piece.length !== 5) return [];
    const [p0, p1, p2, p3, region] = piece as [number[], number[], number[], number[], number[]];
    const left = Math.max(rect.x, region[0]!), top = Math.max(rect.y, region[1]!);
    const right = Math.min(rect.x + rect.width, region[0]! + region[2]!);
    const bottom = Math.min(rect.y + rect.height, region[1]! + region[3]!);
    if (right <= left || bottom <= top) return [];
    const dx1 = p1[0]! - p2[0]!, dx2 = p3[0]! - p2[0]!;
    const dy1 = p1[1]! - p2[1]!, dy2 = p3[1]! - p2[1]!;
    const sx = p0[0]! - p1[0]! + p2[0]! - p3[0]!;
    const sy = p0[1]! - p1[1]! + p2[1]! - p3[1]!;
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(determinant) < 1e-10) return [];
    const g = (sx * dy2 - dx2 * sy) / determinant, h = (dx1 * sy - sx * dy1) / determinant;
    const map = (x: number, y: number) => {
      const u = (x - region[0]!) / region[2]!, v = (y - region[1]!) / region[3]!;
      const w = 1 + g * u + h * v;
      return [((p1[0]! - p0[0]! + g * p1[0]!) * u + (p3[0]! - p0[0]! + h * p3[0]!) * v + p0[0]!) / w,
        ((p1[1]! - p0[1]! + g * p1[1]!) * u + (p3[1]! - p0[1]! + h * p3[1]!) * v + p0[1]!) / w];
    };
    return [[map(left, top), map(right, top), map(right, bottom), map(left, bottom)]];
  });
}
