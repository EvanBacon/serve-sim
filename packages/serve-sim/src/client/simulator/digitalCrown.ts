export const MAX_DIGITAL_CROWN_DELTA = 200;
export const WHEEL_LINE_HEIGHT_PX = 16;
export const MIN_DIGITAL_CROWN_DELTA = 0.01;

export function digitalCrownDeltaFromWheel(
  deltaY: number,
  deltaMode: number,
  pageHeight: number,
): number | null {
  if (!Number.isFinite(deltaY)) return null;
  const safePageHeight = Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 1;
  const deltaPixels =
    deltaMode === 1
      ? deltaY * WHEEL_LINE_HEIGHT_PX
      : deltaMode === 2
        ? deltaY * safePageHeight
        : deltaY;

  // Browser wheel deltas already reflect the user's system scroll direction,
  // matching Simulator.app's AppKit scroll-wheel path.
  const delta = Math.max(
    -MAX_DIGITAL_CROWN_DELTA,
    Math.min(MAX_DIGITAL_CROWN_DELTA, deltaPixels),
  );
  return Math.abs(delta) < MIN_DIGITAL_CROWN_DELTA ? null : delta;
}
