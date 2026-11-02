import { expect, test } from "bun:test";
import { hingeReaderCommand, parseHingeSample, parseIntegratedScreenOrientations, parsePrimaryPanel } from "../duo-state";

test("primary panel readback follows guest hysteresis rather than angle", () => {
  expect(parsePrimaryPanel("[DisplayContentMode] COMPLETED: .cover:pri .inner:aux | 130.0°")).toBe("cover");
  expect(parsePrimaryPanel("[DisplayContentMode] COMPLETED: .cover:aux .inner:pri | 100.0°")).toBe("inner");
  expect(parsePrimaryPanel("[DisplayContentMode] .cover:off .inner:off")).toBeNull();
  expect(parsePrimaryPanel("unrelated .cover:pri")).toBeNull();
  expect(parsePrimaryPanel('Filtering the log data using "category == DisplayContentMode AND (eventMessage CONTAINS .cover:pri OR eventMessage CONTAINS .inner:pri)"')).toBeNull();
  expect(parsePrimaryPanel('[com.apple.log:] log stream --predicate category == DisplayContentMode .cover:pri')).toBeNull();
});

test("hinge samples are the guest reader's angle lines", () => {
  expect(parseHingeSample("angle 130.0")).toBe(130);
  expect(parseHingeSample("angle 128.6\r")).toBe(128.6);
  expect(parseHingeSample("angle 0.0")).toBe(0);
  expect(parseHingeSample("angle 180")).toBe(180);
});

test("hinge samples reject invalid, non-finite, and out-of-range readings", () => {
  for (const line of [
    "angle 181.0", "angle -1.0", "angle NaN", "angle inf", "angle", "angle 1e2", "angle 130.0 extra",
    "Hinge angle unavailable: CMAngleManager reports no hinge",
    // The devicectl format this reader replaced.
    "• +0.1s : Angle:130.0° Mech:130.0° AngleValid:Y",
  ]) {
    expect(parseHingeSample(line)).toBeNull();
  }
});

test("the hinge is read inside the guest, not through devicectl", () => {
  expect(hingeReaderCommand("UDID", "/dist/simduo/serve-sim-duo-hid")).toEqual({
    command: "/usr/bin/xcrun",
    args: ["simctl", "spawn", "UDID", "/dist/simduo/serve-sim-duo-hid", "watch-angle"],
  });
});

test("orientation comes only from named integrated panels", () => {
  const text = `Connected Screens:
    (3) LCD-1:
        Screen ID: 3
        Device Name: primary-1
        Screen Type: Integrated
        UI Orientation: Landscape Left
    (1) LCD:
        Screen ID: 1
        Device Name: primary
        Screen Type: Integrated
        UI Orientation: Portrait Upside Down
    (2) TVOut:
        Device Name: external-0
        Screen Type: TVOut
        UI Orientation: Landscape Right
Port:
    Class: Display`;
  expect(parseIntegratedScreenOrientations(text)).toEqual({
    cover: "portrait_upside_down", inner: "landscape_left",
  });
  expect(parseIntegratedScreenOrientations("UI Orientation: Portrait")).toEqual({});
});
