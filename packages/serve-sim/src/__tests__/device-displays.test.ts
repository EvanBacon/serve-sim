import { describe, expect, test } from "bun:test";
import {
  defaultDeviceDisplay,
  matchDeviceDisplay,
  nameForDisplayRole,
  pixelSizesMatch,
  rolesForIntegratedDisplays,
} from "../device-displays";

describe("device display helpers", () => {
  test("treats rotated framebuffer sizes as the same display", () => {
    expect(pixelSizesMatch({ width: 2007, height: 2853 }, { width: 2853, height: 2007 })).toBe(true);
    expect(pixelSizesMatch({ width: 1398, height: 2034 }, { width: 1398, height: 2034 })).toBe(true);
    expect(pixelSizesMatch({ width: 1398, height: 2034 }, { width: 2007, height: 2853 })).toBe(false);
  });

  test("maps a two-display foldable to cover then inner", () => {
    expect(rolesForIntegratedDisplays([1398 * 2034, 2007 * 2853])).toEqual(["cover", "inner"]);
    expect(rolesForIntegratedDisplays([2007 * 2853, 1398 * 2034])).toEqual(["inner", "cover"]);
    expect(rolesForIntegratedDisplays([1206 * 2622])).toEqual(["display"]);
  });

  test("picks the cover as the default on a foldable", () => {
    const displays = [
      { id: "cover", width: 1398, height: 2034 },
      { id: "inner", width: 2007, height: 2853 },
    ];
    expect(defaultDeviceDisplay(displays)?.id).toBe("cover");
  });

  test("matches a live stream to the cover or inner display", () => {
    const displays = [
      { id: "cover", width: 1398, height: 2034 },
      { id: "inner", width: 2007, height: 2853 },
    ];
    expect(matchDeviceDisplay(displays, 1398, 2034)?.id).toBe("cover");
    expect(matchDeviceDisplay(displays, 2853, 2007)?.id).toBe("inner");
    expect(matchDeviceDisplay(displays, 1206, 2622)).toBeNull();
  });

  test("names foldable roles Cover and Inner", () => {
    expect(nameForDisplayRole("cover")).toBe("Cover");
    expect(nameForDisplayRole("inner")).toBe("Inner");
    expect(nameForDisplayRole("display", "LCD")).toBe("LCD");
  });
});
