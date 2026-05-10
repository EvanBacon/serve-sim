export const SIMULATOR_RESIZE_MIN_WIDTH = 280;
export const SIMULATOR_RESIZE_MAX_SCALE = 3;
export const SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME = 136;
export const SIMULATOR_RESIZE_DRAG_TRANSITION = "width 70ms linear";
export const SIMULATOR_RESIZE_LAYOUT_TRANSITION = "width 0.24s cubic-bezier(0.22, 1, 0.36, 1)";
export const SIMULATOR_RESIZE_PAGE_TRANSITION = "padding-right 0.24s cubic-bezier(0.22, 1, 0.36, 1)";

export function getSimulatorFrameMaxWidth(
  defaultWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  aspectRatio: number,
) {
  const scaledMaxWidth = defaultWidth * SIMULATOR_RESIZE_MAX_SCALE;
  const viewportMaxWidth =
    viewportWidth > 0
      ? Math.max(SIMULATOR_RESIZE_MIN_WIDTH, viewportWidth - 48)
      : scaledMaxWidth;
  const viewportMaxHeight =
    viewportHeight > 0 && Number.isFinite(aspectRatio) && aspectRatio > 0
      ? Math.max(
          SIMULATOR_RESIZE_MIN_WIDTH,
          (viewportHeight - SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME) * aspectRatio,
        )
      : scaledMaxWidth;
  return Math.min(scaledMaxWidth, viewportMaxWidth, viewportMaxHeight);
}

export function clampSimulatorFrameWidth(
  value: number,
  defaultWidth: number,
  viewportWidth: number,
  viewportHeight: number,
  aspectRatio: number,
) {
  const maxWidth = getSimulatorFrameMaxWidth(defaultWidth, viewportWidth, viewportHeight, aspectRatio);
  const minWidth = Math.min(SIMULATOR_RESIZE_MIN_WIDTH, maxWidth);
  return Math.min(maxWidth, Math.max(minWidth, value));
}
