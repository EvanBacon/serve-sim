import { describe, expect, test } from "bun:test";
import { displaySizeForHingeDegrees, poseForDisplayRole, resolveDevicePose } from "../device-pose";

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
});
