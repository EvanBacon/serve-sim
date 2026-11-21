import { describe, expect, test } from "bun:test";
import { displaySizeForHingeDegrees, displaySizeForPanel, duoPanel, duoTouchPanel, poseForDisplayRole, resolveDevicePose } from "../device-pose";

describe("device pose presets", () => {
  test("closed uses the cover display at 0°", () => {
    expect(resolveDevicePose("closed")).toMatchObject({
      hingeDegrees: 0,
      coverActive: true,
      width: 1398,
      height: 2034,
    });
  });

  test("open uses the inner display at 180°", () => {
    expect(resolveDevicePose("open")).toMatchObject({
      hingeDegrees: 180,
      coverActive: false,
      width: 2007,
      height: 2853,
    });
  });

  test("aliases cover/inner/flat onto closed and open", () => {
    expect(resolveDevicePose("cover")?.id).toBe("closed");
    expect(resolveDevicePose("inner")?.id).toBe("open");
    expect(resolveDevicePose("flat")?.id).toBe("open");
  });

  test("maps display roles onto closed and open poses", () => {
    expect(poseForDisplayRole("cover")?.id).toBe("closed");
    expect(poseForDisplayRole("inner")?.id).toBe("open");
    expect(poseForDisplayRole("display")).toBeNull();
  });

  test("picks cover vs inner framebuffer from a raw hinge angle", () => {
    expect(displaySizeForHingeDegrees(0)).toEqual({
      coverActive: true,
      width: 1398,
      height: 2034,
    });
    expect(displaySizeForHingeDegrees(89).coverActive).toBe(true);
    expect(displaySizeForHingeDegrees(90)).toEqual({
      coverActive: false,
      width: 2007,
      height: 2853,
    });
  });

  test("primary panel wins over the hinge rule", () => {
    expect(duoPanel({ primaryPanel: "cover", hingeDegrees: 180 })).toBe("cover");
    expect(duoPanel({ primaryPanel: "inner", hingeDegrees: 0 })).toBe("inner");
    expect(displaySizeForPanel("inner")).toEqual({ coverActive: false, width: 2007, height: 2853 });
  });
});

describe("duoTouchPanel", () => {
  test("follows the primary-panel readback first", () => {
    expect(duoTouchPanel({ primaryPanel: "inner", hingeDegrees: 0, width: 1398, height: 2034 })).toBe("inner");
    expect(duoTouchPanel({ primaryPanel: "cover", hingeDegrees: 180, width: 2007, height: 2853 })).toBe("cover");
  });
  test("then the 90° hinge rule", () => {
    expect(duoTouchPanel({ hingeDegrees: 130, width: 1398, height: 2034 })).toBe("inner");
    expect(duoTouchPanel({ hingeDegrees: 10, width: 2007, height: 2853 })).toBe("cover");
  });
  test("then the captured framebuffer, before any Duo state is known", () => {
    expect(duoTouchPanel({ width: 2007, height: 2853 })).toBe("inner");
    expect(duoTouchPanel({ width: 2853, height: 2007 })).toBe("inner");
    expect(duoTouchPanel({ width: 1398, height: 2034 })).toBe("cover");
  });
  test("defaults to the cover before the first frame (0×0)", () => {
    expect(duoTouchPanel({ width: 0, height: 0 })).toBe("cover");
    expect(duoTouchPanel({ primaryPanel: null, hingeDegrees: null, width: 0, height: 0 })).toBe("cover");
  });
});
