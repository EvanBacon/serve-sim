import type { SimulatorOrientation } from "../types";
import type { DeviceKitChromeDescriptor } from "./grid";
import { rotationDegreesForOrientation } from "../simulator/orientation";

/**
 * Device-rotation animation for the live preview.
 *
 * The bezel (DeviceKit chrome) is authored portrait and the raw framebuffer is
 * the physical (portrait) panel, so a rotated device is just the portrait
 * device turned on the page — exactly what Simulator.app shows. The preview
 * renders the whole device (bezel + screen) inside a "rotor" turned by the
 * orientation angle, and counter-rotates the screen content back into display
 * space so the stream, input layer, and overlays stay axis-aligned at rest.
 * When the orientation changes, the rotor animates from the previous pose to
 * the new one (FLIP), so the bezel and screen spin together as one unit.
 */

/** Simulator.app turns the device in ~0.3–0.4s. */
export const DEVICE_ROTATION_DURATION_MS = 360;
export const DEVICE_ROTATION_EASING = "cubic-bezier(0.45, 0, 0.2, 1)";

/** Clockwise page rotation of the physical device for an orientation. Same
 *  angle the stream view uses to stand portrait frames upright. */
export function deviceRotationDegrees(orientation?: SimulatorOrientation | null): number {
  return rotationDegreesForOrientation(orientation);
}

export function isSidewaysRotation(degrees: number): boolean {
  return Math.abs(degrees) % 180 === 90;
}

export interface DeviceChromeLayout {
  /** Container width / height at rest. */
  aspectRatio: number;
  aspectRatioCss: string;
  /** Container width / displayed screen width. */
  chromeScale: number;
}

/** Container geometry for a framed device in `orientation`: the portrait
 *  frame, laid on its side for landscape. */
export function deviceChromeLayout(
  chrome: Pick<DeviceKitChromeDescriptor, "frame" | "screen">,
  orientation?: SimulatorOrientation | null,
): DeviceChromeLayout {
  const { frame, screen } = chrome;
  if (isSidewaysRotation(deviceRotationDegrees(orientation))) {
    return {
      aspectRatio: frame.height / frame.width,
      aspectRatioCss: `${frame.height} / ${frame.width}`,
      chromeScale: frame.height / screen.height,
    };
  }
  return {
    aspectRatio: frame.width / frame.height,
    aspectRatioCss: `${frame.width} / ${frame.height}`,
    chromeScale: frame.width / screen.width,
  };
}

/** Normalize to [-180, 180). */
function shortestTurn(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * First keyframe of a rotation, expressed in the *new* layout: the rotor is
 * already laid out for `toDegrees`, so it starts turned back to the pose the
 * viewer last saw (`fromDegrees`, possibly mid-animation) by the shortest way,
 * and scaled so its on-screen size matches the previous layout's.
 */
export function deviceRotationStart({
  fromDegrees,
  toDegrees,
  fromScale = 1,
  fromLength,
  toLength,
}: {
  fromDegrees: number;
  toDegrees: number;
  /** Scale the rotor was visibly drawn at (≠1 when interrupted mid-animation). */
  fromScale?: number;
  /** Rotor long edge (layout px) before and after the change. */
  fromLength?: number;
  toLength?: number;
}): { degrees: number; scale: number } {
  const degrees = toDegrees + shortestTurn(fromDegrees - toDegrees);
  const scale =
    fromLength && toLength && fromLength > 0 && toLength > 0
      ? (fromScale * fromLength) / toLength
      : 1;
  return { degrees, scale };
}

/** Angle (degrees) and uniform scale of a 2D affine matrix's linear part. */
export function rotationFromMatrix(m: { a: number; b: number }): { degrees: number; scale: number } {
  return {
    degrees: (Math.atan2(m.b, m.a) * 180) / Math.PI,
    scale: Math.hypot(m.a, m.b),
  };
}
