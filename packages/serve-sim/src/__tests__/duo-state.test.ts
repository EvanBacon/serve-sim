import { expect, test } from "bun:test";
import { parseHingeSample, parseIntegratedScreenOrientations, parsePrimaryPanel } from "../duo-state";

test("primary panel readback follows guest hysteresis rather than angle", () => {
  expect(parsePrimaryPanel("[DisplayContentMode] COMPLETED: .cover:pri .inner:aux | 130.0°")).toBe("cover");
  expect(parsePrimaryPanel("[DisplayContentMode] COMPLETED: .cover:aux .inner:pri | 100.0°")).toBe("inner");
  expect(parsePrimaryPanel("[DisplayContentMode] .cover:off .inner:off")).toBeNull();
  expect(parsePrimaryPanel("unrelated .cover:pri")).toBeNull();
  expect(parsePrimaryPanel('Filtering the log data using "category == DisplayContentMode AND (eventMessage CONTAINS .cover:pri OR eventMessage CONTAINS .inner:pri)"')).toBeNull();
  expect(parsePrimaryPanel('[com.apple.log:] log stream --predicate category == DisplayContentMode .cover:pri')).toBeNull();
});

test("hinge samples reject invalid, non-finite, and out-of-range readings", () => {
  expect(parseHingeSample("• +0.1s : Angle:130.0° Mech:130.0° AngleValid:Y")).toBe(130);
  expect(parseHingeSample("• Angle:0.0° AngleValid:Y")).toBe(0);
  for (const line of ["Angle:130.0° AngleValid:N", "Angle:181° AngleValid:Y", "Angle:NaN° AngleValid:Y", "monitoring started"]) {
    expect(parseHingeSample(line)).toBeNull();
  }
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
