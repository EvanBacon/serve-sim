import { describe, expect, test } from "bun:test";
import {
  HID_EDGE_BOTTOM,
  HID_EDGE_LEFT,
  HID_EDGE_RIGHT,
  HID_EDGE_TOP,
} from "../client/simulator/orientation";
import {
  cliInputOrientation,
  configUrlForWsUrl,
  displayTouchToRaw,
} from "../touch-remap";

// iPad Pro 13-inch raw frame: the capture stays portrait after rotation.
const RAW_W = 2064;
const RAW_H = 2752;

describe("cliInputOrientation", () => {
  test("remaps every rotated orientation while the raw frame stays portrait", () => {
    for (const orientation of ["landscape_left", "landscape_right", "portrait_upside_down"] as const) {
      expect(cliInputOrientation({ width: RAW_W, height: RAW_H, orientation })).toBe(orientation);
    }
  });

  test("does not remap portrait", () => {
    expect(cliInputOrientation({ width: RAW_W, height: RAW_H, orientation: "portrait" })).toBeUndefined();
  });

  test("does not double-rotate a frame that is already landscape", () => {
    expect(
      cliInputOrientation({ width: RAW_H, height: RAW_W, orientation: "landscape_left" }),
    ).toBeUndefined();
  });

  test("ignores missing, malformed, or unknown config", () => {
    expect(cliInputOrientation(null)).toBeUndefined();
    expect(cliInputOrientation("nope")).toBeUndefined();
    expect(cliInputOrientation({ orientation: "landscape_left" })).toBeUndefined();
    expect(cliInputOrientation({ width: RAW_W, height: RAW_H, orientation: "sideways" })).toBeUndefined();
  });
});

describe("displayTouchToRaw", () => {
  // Issue #153: Files icon on an iPad in landscape_left, measured from a
  // landscape screenshot at (0.715, 0.343), opens at raw (0.343, 0.285).
  test("landscape_left maps display (x, y) to raw (y, 1 - x)", () => {
    const raw = displayTouchToRaw({ type: "begin", x: 0.715, y: 0.343 }, "landscape_left");
    expect(raw.type).toBe("begin");
    expect(raw.x).toBeCloseTo(0.343, 6);
    expect(raw.y).toBeCloseTo(0.285, 6);
  });

  test("landscape_right maps display (x, y) to raw (1 - y, x)", () => {
    const raw = displayTouchToRaw({ type: "end", x: 0.2, y: 0.9 }, "landscape_right");
    expect(raw.x).toBeCloseTo(0.1, 6);
    expect(raw.y).toBeCloseTo(0.2, 6);
  });

  test("portrait_upside_down maps display (x, y) to raw (1 - x, 1 - y)", () => {
    const raw = displayTouchToRaw({ type: "move", x: 0.2, y: 0.9 }, "portrait_upside_down");
    expect(raw.x).toBeCloseTo(0.8, 6);
    expect(raw.y).toBeCloseTo(0.1, 6);
  });

  test("portrait and no orientation pass through unchanged", () => {
    const touch = { type: "begin", x: 0.25, y: 0.75 };
    expect(displayTouchToRaw(touch, "portrait")).toEqual(touch);
    expect(displayTouchToRaw(touch, undefined)).toEqual(touch);
  });

  test("display corners land on the matching raw corners", () => {
    // Display top-left is the corner of the raw frame that faces the user's top-left.
    expect(displayTouchToRaw({ type: "begin", x: 0, y: 0 }, "landscape_left")).toMatchObject({ x: 0, y: 1 });
    expect(displayTouchToRaw({ type: "begin", x: 0, y: 0 }, "landscape_right")).toMatchObject({ x: 1, y: 0 });
    expect(displayTouchToRaw({ type: "begin", x: 0, y: 0 }, "portrait_upside_down")).toMatchObject({ x: 1, y: 1 });
  });

  test("remaps edge hints and leaves edge 0 / absent alone", () => {
    expect(
      displayTouchToRaw({ type: "begin", x: 0.5, y: 0.95, edge: HID_EDGE_BOTTOM }, "landscape_left").edge,
    ).toBe(HID_EDGE_RIGHT);
    expect(
      displayTouchToRaw({ type: "begin", x: 0.5, y: 0.95, edge: HID_EDGE_BOTTOM }, "landscape_right").edge,
    ).toBe(HID_EDGE_LEFT);
    expect(
      displayTouchToRaw({ type: "begin", x: 0.5, y: 0.95, edge: HID_EDGE_BOTTOM }, "portrait_upside_down").edge,
    ).toBe(HID_EDGE_TOP);
    expect(
      displayTouchToRaw({ type: "begin", x: 0.5, y: 0.95, edge: HID_EDGE_BOTTOM }, "portrait").edge,
    ).toBe(HID_EDGE_BOTTOM);
    expect(displayTouchToRaw({ type: "begin", x: 0.5, y: 0.5, edge: 0 }, "landscape_left").edge).toBe(0);
    expect("edge" in displayTouchToRaw({ type: "begin", x: 0.5, y: 0.5 }, "landscape_left")).toBe(false);
  });
});

describe("configUrlForWsUrl", () => {
  test("derives /config next to the HID socket for local and remote targets", () => {
    expect(configUrlForWsUrl("ws://127.0.0.1:3300/helper/ABC/ws")).toBe("http://127.0.0.1:3300/helper/ABC/config");
    expect(configUrlForWsUrl("wss://sim.example.com/base/helper/ABC/ws")).toBe(
      "https://sim.example.com/base/helper/ABC/config",
    );
    expect(configUrlForWsUrl("ws://127.0.0.1:3100/other")).toBeNull();
    expect(configUrlForWsUrl("not a url")).toBeNull();
  });
});
