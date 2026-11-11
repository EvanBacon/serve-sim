import { describe, expect, test } from "bun:test";
import {
  DEVICE_ROTATION_DURATION_MS,
  deviceChromeLayout as layoutFor,
  isOrientationConfirmed,
  isUnorientedLandscape,
  deviceRotationDegrees,
  deviceRotationStart,
  isSidewaysRotation,
  rotationFromMatrix,
} from "../client/utils/device-rotation";

type Orientation = Parameters<typeof layoutFor>[1]["orientation"];

/** Layout for a config whose raw framebuffer is the portrait panel. */
function deviceChromeLayout(c: typeof chrome, orientation: Orientation) {
  const layout = layoutFor(c, { width: 1179, height: 2556, orientation });
  if (!layout) throw new Error("expected a chrome layout");
  return layout;
}

const chrome = {
  frame: { width: 1000, height: 2000 },
  screen: { x: 50, y: 60, width: 900, height: 1880 },
};

describe("deviceRotationDegrees", () => {
  test("matches the stream's clockwise CSS rotation per orientation", () => {
    expect(deviceRotationDegrees("portrait")).toBe(0);
    expect(deviceRotationDegrees("landscape_left")).toBe(90);
    expect(deviceRotationDegrees("portrait_upside_down")).toBe(180);
    expect(deviceRotationDegrees("landscape_right")).toBe(-90);
    expect(deviceRotationDegrees(undefined)).toBe(0);
  });

  test("sideways only for the landscape orientations", () => {
    expect(isSidewaysRotation(90)).toBe(true);
    expect(isSidewaysRotation(-90)).toBe(true);
    expect(isSidewaysRotation(0)).toBe(false);
    expect(isSidewaysRotation(180)).toBe(false);
  });

  test("lasts roughly as long as Simulator.app's rotation", () => {
    expect(DEVICE_ROTATION_DURATION_MS).toBeGreaterThanOrEqual(300);
    expect(DEVICE_ROTATION_DURATION_MS).toBeLessThanOrEqual(400);
  });
});

describe("deviceChromeLayout", () => {
  test("portrait and upside-down keep the authored portrait frame", () => {
    for (const orientation of ["portrait", "portrait_upside_down"] as const) {
      const layout = deviceChromeLayout(chrome, orientation);
      expect(layout.aspectRatio).toBeCloseTo(0.5);
      expect(layout.aspectRatioCss).toBe("1000 / 2000");
      expect(layout.chromeScale).toBeCloseTo(1000 / 900);
    }
  });

  test("landscape lays the frame on its side instead of dropping it", () => {
    for (const orientation of ["landscape_left", "landscape_right"] as const) {
      const layout = deviceChromeLayout(chrome, orientation);
      expect(layout.aspectRatio).toBeCloseTo(2);
      expect(layout.aspectRatioCss).toBe("2000 / 1000");
      // Container width is the frame's long edge; the display width is the
      // screen's long edge.
      expect(layout.chromeScale).toBeCloseTo(2000 / 1880);
    }
  });
});

describe("orientation-less landscape configs", () => {
  test("a width > height config with no orientation drops the bezel", () => {
    const config = { width: 2556, height: 1179 };
    expect(isUnorientedLandscape(config)).toBe(true);
    // Not a portrait bezel with a tiny letterboxed landscape stream.
    expect(layoutFor(chrome, config)).toBeNull();
  });

  test("oriented or portrait-shaped configs keep the bezel", () => {
    expect(isUnorientedLandscape({ width: 1179, height: 2556 })).toBe(false);
    expect(isUnorientedLandscape({ width: 2556, height: 1179, orientation: "landscape_left" })).toBe(false);
    expect(layoutFor(chrome, { width: 1179, height: 2556 })?.aspectRatioCss).toBe("1000 / 2000");
    // Raw landscape frames with a known orientation still turn the frame.
    expect(
      layoutFor(chrome, { width: 2556, height: 1179, orientation: "landscape_right" })?.aspectRatioCss,
    ).toBe("2000 / 1000");
  });
});

describe("deviceRotationStart", () => {
  test("starts from the previous pose and turns the short way", () => {
    // Toolbar rotate cycles portrait → landscape_left → upside down → landscape_right.
    expect(deviceRotationStart({ fromDegrees: 0, toDegrees: 90 }).degrees).toBe(0);
    expect(deviceRotationStart({ fromDegrees: 90, toDegrees: 180 }).degrees).toBe(90);
    // 180 → -90 (≡ 270) must not spin 270° backwards: start at -180 and turn +90.
    expect(deviceRotationStart({ fromDegrees: 180, toDegrees: -90 }).degrees).toBe(-180);
    expect(deviceRotationStart({ fromDegrees: -90, toDegrees: 0 }).degrees).toBe(-90);
    // Reverse direction (⌘→).
    expect(deviceRotationStart({ fromDegrees: 0, toDegrees: -90 }).degrees).toBe(0);
    expect(deviceRotationStart({ fromDegrees: -90, toDegrees: 180 }).degrees).toBe(270);
  });

  test("a half turn picks one direction deterministically", () => {
    const start = deviceRotationStart({ fromDegrees: 0, toDegrees: 180 }).degrees;
    expect(Math.abs(start - 180)).toBe(180);
  });

  test("continues from a mid-animation pose without snapping", () => {
    // Interrupted at 45° on the way to 90°, now heading to 180°.
    expect(deviceRotationStart({ fromDegrees: 45, toDegrees: 180 }).degrees).toBe(45);
  });

  test("scales from the previous on-screen size to the new one", () => {
    const start = deviceRotationStart({
      fromDegrees: 0,
      toDegrees: 90,
      fromLength: 700,
      toLength: 760,
    });
    expect(start.scale).toBeCloseTo(700 / 760);
    // Carries an in-flight scale through an interruption.
    expect(
      deviceRotationStart({ fromDegrees: 0, toDegrees: 90, fromScale: 0.5, fromLength: 800, toLength: 400 }).scale,
    ).toBeCloseTo(1);
  });

  test("falls back to scale 1 when sizes are unknown", () => {
    expect(deviceRotationStart({ fromDegrees: 0, toDegrees: 90 }).scale).toBe(1);
    expect(deviceRotationStart({ fromDegrees: 0, toDegrees: 90, fromLength: 0, toLength: 500 }).scale).toBe(1);
  });
});

describe("rotationFromMatrix", () => {
  test("reads the angle and uniform scale out of a 2D transform", () => {
    const rad = (30 * Math.PI) / 180;
    const s = 0.8;
    const m = { a: s * Math.cos(rad), b: s * Math.sin(rad) };
    const out = rotationFromMatrix(m);
    expect(out.degrees).toBeCloseTo(30);
    expect(out.scale).toBeCloseTo(0.8);
  });
});

describe("isOrientationConfirmed", () => {
  const sizeOnly = { width: 1179, height: 2556 };
  const landscape = { width: 1179, height: 2556, orientation: "landscape_left" as const };

  test("no config yet is unconfirmed", () => {
    expect(isOrientationConfirmed(null, null)).toBe(false);
  });

  test("a size-only frame config (MJPEG onLoad) is not confirmed", () => {
    expect(isOrientationConfirmed(sizeOnly, null)).toBe(false);
  });

  test("size-only frame then oriented push: only the push confirms", () => {
    // MJPEG frame decodes first, then 0x82 arrives and the live config is
    // cleared because its orientation differs. The first render must not count
    // as confirmed, or the rotor spins 0° → 90° on first load.
    expect(isOrientationConfirmed(sizeOnly, null)).toBe(false);
    expect(isOrientationConfirmed(null, landscape)).toBe(true);
  });

  test("the live config wins over the ws config, like activeStreamConfig", () => {
    expect(isOrientationConfirmed(sizeOnly, landscape)).toBe(false);
    expect(isOrientationConfirmed(landscape, sizeOnly)).toBe(true);
    expect(isOrientationConfirmed({ ...sizeOnly, orientation: "portrait" }, null)).toBe(true);
  });
});
