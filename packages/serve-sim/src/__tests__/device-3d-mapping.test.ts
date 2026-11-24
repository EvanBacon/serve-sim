import { describe, expect, test } from "bun:test";
import { HID_EDGE_BOTTOM } from "../client/simulator/orientation";
import {
  displayPointForScreenUv,
  rawPointForScreenUv,
  screenTouchPayload,
  screenUvToRawMatrix,
  startsEdgeGesture,
} from "../client/utils/device-3d-mapping";

const portrait = { width: 1206, height: 2622, orientation: "portrait" as const };
const landscapeLeft = { width: 1206, height: 2622, orientation: "landscape_left" as const };

describe("3D screen mapping", () => {
  test("portrait is the identity", () => {
    expect(rawPointForScreenUv({ u: 0.25, v: 0.75 }, 0, portrait)).toEqual({ x: 0.25, y: 0.75 });
    expect(screenUvToRawMatrix(0, portrait)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  test("quarter turns move the portrait screen into the upright display", () => {
    // Device turned 90° clockwise: its top-left corner lands top-right.
    expect(displayPointForScreenUv({ u: 0, v: 0 }, 90)).toEqual({ x: 1, y: 0 });
    expect(displayPointForScreenUv({ u: 0, v: 0 }, -90)).toEqual({ x: 0, y: 1 });
    expect(displayPointForScreenUv({ u: 0, v: 0 }, 180)).toEqual({ x: 1, y: 1 });
    expect(displayPointForScreenUv({ u: 0.3, v: 0.6 }, 360)).toEqual({ x: 0.3, y: 0.6 });
  });

  test("the texture matrix agrees with the touch mapping in every orientation", () => {
    for (const degrees of [0, 90, 180, -90]) {
      for (const config of [portrait, landscapeLeft, null]) {
        const [a, b, c, d, tx, ty] = screenUvToRawMatrix(degrees, config);
        for (const [u, v] of [[0.1, 0.2], [0.9, 0.4], [0.5, 0.5]] as const) {
          const raw = rawPointForScreenUv({ u, v }, degrees, config);
          expect(a * u + c * v + tx).toBeCloseTo(raw.x, 9);
          expect(b * u + d * v + ty).toBeCloseTo(raw.y, 9);
        }
      }
    }
  });

  test("touches are clamped onto the screen", () => {
    expect(screenTouchPayload("move", { u: -0.2, v: 1.4 }, 0, portrait, false)).toEqual({
      type: "move",
      x: 0,
      y: 1,
    });
  });

  test("a drag from the home indicator band is tagged as the bottom edge", () => {
    expect(startsEdgeGesture({ u: 0.5, v: 0.995 }, 0)).toBe(true);
    expect(startsEdgeGesture({ u: 0.5, v: 0.5 }, 0)).toBe(false);
    const touch = screenTouchPayload("begin", { u: 0.5, v: 0.995 }, 0, portrait, true);
    expect(touch.edge).toBe(HID_EDGE_BOTTOM);
    expect(screenTouchPayload("begin", { u: 0.5, v: 0.5 }, 0, portrait, false).edge).toBeUndefined();
  });

  test("in landscape the home band follows the display, not the glass", () => {
    // Turned 90° clockwise, the display's bottom is the glass's right side.
    expect(startsEdgeGesture({ u: 0.995, v: 0.5 }, 90)).toBe(true);
    expect(startsEdgeGesture({ u: 0.005, v: 0.5 }, 90)).toBe(false);
    expect(startsEdgeGesture({ u: 0.5, v: 0.995 }, 90)).toBe(false);
  });
});
