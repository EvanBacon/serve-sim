import type { SimulatorOrientation, StreamConfig } from "../types.js";

export const HID_EDGE_LEFT = 1;
export const HID_EDGE_TOP = 2;
export const HID_EDGE_BOTTOM = 3;
export const HID_EDGE_RIGHT = 4;

/**
 * Bottom fraction of the display treated as the home-indicator hot zone, in
 * normalized (0–1) display coordinates. A drag that *starts* here is tagged
 * with `HID_EDGE_BOTTOM` so iOS routes it to the interactive swipe-to-home
 * recognizer.
 *
 * Kept narrow (bottom 7%). The previous 0.88 (bottom 12%) reached up into
 * Safari's bottom URL bar, so swiping up on the URL bar to reveal the tab
 * overview was misread as swipe-to-home. iOS only uses the flag for swipe
 * disambiguation, so a tighter band still lets the genuine home gesture
 * through while leaving URL-bar swipes as plain touches.
 */
export const HOME_INDICATOR_BAND_NORM = 0.93;

/**
 * Returns `HID_EDGE_BOTTOM` when a display-space touch beginning at normalized
 * `y` falls inside the home-indicator hot zone, otherwise `undefined`. Edge
 * remapping for non-portrait orientations is handled downstream by
 * {@link rawEdgeForDisplayEdge}.
 */
export function homeIndicatorEdge(y: number): number | undefined {
  return y >= HOME_INDICATOR_BAND_NORM ? HID_EDGE_BOTTOM : undefined;
}

export function isLandscapeOrientation(
  orientation?: SimulatorOrientation | null,
): boolean {
  return orientation === "landscape_left" || orientation === "landscape_right";
}

export function isLandscapeConfig(
  config?: Pick<StreamConfig, "width" | "height" | "orientation"> | null,
): boolean {
  return !!config && (isLandscapeOrientation(config.orientation) || config.width > config.height);
}

export function displayStreamConfig<
  T extends Pick<StreamConfig, "width" | "height" | "orientation">,
>(
  config?: T | null,
): T | null {
  if (!config || config.width <= 0 || config.height <= 0) return null;
  const landscape = isLandscapeOrientation(config.orientation) || config.width > config.height;
  const width = landscape
    ? Math.max(config.width, config.height)
    : Math.min(config.width, config.height);
  const height = landscape
    ? Math.min(config.width, config.height)
    : Math.max(config.width, config.height);
  if (width === config.width && height === config.height) return config;
  return { ...config, width, height };
}

export interface StreamDisplayGeometry {
  displayConfig: StreamConfig | null;
  rotationDegrees: number;
  needsCssRotation: boolean;
  inputOrientation?: SimulatorOrientation;
}

export function streamDisplayGeometry(
  config?: Pick<StreamConfig, "width" | "height" | "orientation"> | null,
): StreamDisplayGeometry {
  const displayConfig = displayStreamConfig(config);
  const orientationRotation = rotationDegreesForOrientation(config?.orientation);
  const rotatesSideways = Math.abs(orientationRotation) === 90;
  const rawIsLandscape = !!config && config.width > config.height;
  const needsCssRotation =
    orientationRotation === 180 || (rotatesSideways && !rawIsLandscape);

  return {
    displayConfig,
    rotationDegrees: needsCssRotation ? orientationRotation : 0,
    needsCssRotation,
    inputOrientation: needsCssRotation ? config?.orientation : undefined,
  };
}

export function rotationDegreesForOrientation(
  orientation?: SimulatorOrientation | null,
): number {
  switch (orientation) {
    case "landscape_left":
      return 90;
    case "landscape_right":
      return -90;
    case "portrait_upside_down":
      return 180;
    default:
      return 0;
  }
}

export function rawPointForDisplayPoint(
  orientation: SimulatorOrientation | null | undefined,
  x: number,
  y: number,
): { x: number; y: number } {
  switch (orientation) {
    case "landscape_left":
      return { x: y, y: 1 - x };
    case "landscape_right":
      return { x: 1 - y, y: x };
    case "portrait_upside_down":
      return { x: 1 - x, y: 1 - y };
    default:
      return { x, y };
  }
}

export function rawEdgeForDisplayEdge(
  orientation: SimulatorOrientation | null | undefined,
  edge: number,
): number {
  switch (orientation) {
    case "landscape_left":
      switch (edge) {
        case HID_EDGE_LEFT:
          return HID_EDGE_BOTTOM;
        case HID_EDGE_RIGHT:
          return HID_EDGE_TOP;
        case HID_EDGE_TOP:
          return HID_EDGE_LEFT;
        case HID_EDGE_BOTTOM:
          return HID_EDGE_RIGHT;
        default:
          return edge;
      }
    case "landscape_right":
      switch (edge) {
        case HID_EDGE_LEFT:
          return HID_EDGE_TOP;
        case HID_EDGE_RIGHT:
          return HID_EDGE_BOTTOM;
        case HID_EDGE_TOP:
          return HID_EDGE_RIGHT;
        case HID_EDGE_BOTTOM:
          return HID_EDGE_LEFT;
        default:
          return edge;
      }
    case "portrait_upside_down":
      switch (edge) {
        case HID_EDGE_LEFT:
          return HID_EDGE_RIGHT;
        case HID_EDGE_RIGHT:
          return HID_EDGE_LEFT;
        case HID_EDGE_TOP:
          return HID_EDGE_BOTTOM;
        case HID_EDGE_BOTTOM:
          return HID_EDGE_TOP;
        default:
          return edge;
      }
    default:
      return edge;
  }
}
