import { describe, expect, test } from "bun:test";
import {
  fallbackScreenSize,
  screenBorderRadius,
  simulatorAspectRatio,
  simulatorMaxWidth,
  simulatorResizeCornerArc,
} from "../simulator/deviceFrames";
import {
  displayStreamConfig,
  HID_EDGE_BOTTOM,
  HID_EDGE_LEFT,
  HID_EDGE_RIGHT,
  isLandscapeConfig,
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  rotationDegreesForOrientation,
  streamDisplayGeometry,
} from "../simulator/orientation";

describe("simulator geometry helpers", () => {
  test("detects landscape from live stream dimensions", () => {
    expect(isLandscapeConfig({ width: 2868, height: 1320 })).toBe(true);
    expect(isLandscapeConfig({ width: 1320, height: 2868 })).toBe(false);
    expect(isLandscapeConfig(null)).toBe(false);
  });

  test("uses live stream dimensions for aspect ratio before fallback", () => {
    expect(
      simulatorAspectRatio(
        { width: 2868, height: 1320 },
        { width: 1320, height: 2868 },
      ),
    ).toBe("2868 / 1320");
  });

  test("uses requested landscape orientation when the raw frame remains portrait", () => {
    const rawPortraitLandscape = {
      width: 1320,
      height: 2868,
      orientation: "landscape_left" as const,
    };

    expect(isLandscapeConfig(rawPortraitLandscape)).toBe(true);
    expect(displayStreamConfig(rawPortraitLandscape)).toEqual({
      width: 2868,
      height: 1320,
      orientation: "landscape_left",
    });
    expect(simulatorAspectRatio(rawPortraitLandscape)).toBe("2868 / 1320");
    expect(simulatorMaxWidth("iphone", rawPortraitLandscape)).toBe(620);
  });

  test("falls back to known portrait screen dimensions", () => {
    expect(fallbackScreenSize("iphone", "iPhone 16 Pro Max")).toEqual({
      width: 1320,
      height: 2868,
    });
    expect(simulatorAspectRatio(null, fallbackScreenSize("iphone", "iPhone 16 Pro Max"))).toBe(
      "1320 / 2868",
    );
  });

  test("uses wider max width for landscape phones and tablets", () => {
    expect(simulatorMaxWidth("iphone", { width: 2868, height: 1320 })).toBe(620);
    expect(simulatorMaxWidth("ipad", { width: 2752, height: 2064 })).toBe(720);
    expect(simulatorMaxWidth("iphone", { width: 1320, height: 2868 })).toBe(320);
  });

  test("swaps border-radius percentages for landscape screens", () => {
    const portrait = screenBorderRadius("iphone", { width: 1320, height: 2868 });
    const landscape = screenBorderRadius("iphone", { width: 2868, height: 1320 });
    expect(landscape).toBe(portrait.split(" / ").reverse().join(" / "));
  });

  test("resize corner arc uses opposing sweep flags for d vs dFill", () => {
    const arc = simulatorResizeCornerArc({
      type: "iphone",
      config: null,
      containerWidth: 400,
      containerHeight: 860,
    });
    expect(arc.d).toMatch(/A [\d.]+ [\d.]+ 0 0 1/);
    expect(arc.dFill).toMatch(/A [\d.]+ [\d.]+ 0 0 0/);
  });

  test("maps visual landscape touch coordinates back to the raw portrait surface", () => {
    expect(rotationDegreesForOrientation("landscape_left")).toBe(90);
    expect(rawPointForDisplayPoint("landscape_left", 0.25, 0.75)).toEqual({
      x: 0.75,
      y: 0.75,
    });
    expect(rawEdgeForDisplayEdge("landscape_left", HID_EDGE_BOTTOM)).toBe(HID_EDGE_RIGHT);

    expect(rotationDegreesForOrientation("landscape_right")).toBe(-90);
    expect(rawPointForDisplayPoint("landscape_right", 0.25, 0.75)).toEqual({
      x: 0.25,
      y: 0.25,
    });
    expect(rawEdgeForDisplayEdge("landscape_right", HID_EDGE_BOTTOM)).toBe(HID_EDGE_LEFT);
  });

  test("rotates and remaps only when the raw frame remains portrait", () => {
    const rawPortraitLandscape = {
      width: 1320,
      height: 2868,
      orientation: "landscape_left" as const,
    };
    const geometry = streamDisplayGeometry(rawPortraitLandscape);

    expect(geometry.displayConfig).toEqual({
      width: 2868,
      height: 1320,
      orientation: "landscape_left",
    });
    expect(geometry.needsCssRotation).toBe(true);
    expect(geometry.rotationDegrees).toBe(90);
    expect(geometry.inputOrientation).toBe("landscape_left");
    expect(rawPointForDisplayPoint(geometry.inputOrientation, 0.25, 0.75)).toEqual({
      x: 0.75,
      y: 0.75,
    });
  });

  test("does not double-rotate or remap frames that are already landscape", () => {
    const rawLandscape = {
      width: 2868,
      height: 1320,
      orientation: "landscape_left" as const,
    };
    const geometry = streamDisplayGeometry(rawLandscape);

    expect(geometry.displayConfig).toEqual(rawLandscape);
    expect(geometry.needsCssRotation).toBe(false);
    expect(geometry.rotationDegrees).toBe(0);
    expect(geometry.inputOrientation).toBeUndefined();
    expect(rawPointForDisplayPoint(geometry.inputOrientation, 0.25, 0.75)).toEqual({
      x: 0.25,
      y: 0.75,
    });
    expect(rawEdgeForDisplayEdge(geometry.inputOrientation, HID_EDGE_BOTTOM)).toBe(HID_EDGE_BOTTOM);
  });
});
