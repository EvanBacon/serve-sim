export function clampHingeAngle(angle: number): number {
  return Math.min(180, Math.max(0, angle));
}

/** Pinch out unfolds; pinch in closes. Doubling finger separation spans 180°. */
export function hingeAngleForPinch(startAngle: number, scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(startAngle)) return startAngle;
  return clampHingeAngle(startAngle + 180 * Math.log2(scale));
}

export function hingeAngleForWheel(angle: number, deltaY: number): number {
  return Number.isFinite(deltaY) ? clampHingeAngle(angle - deltaY) : angle;
}
